#!/usr/bin/env node
// Turn a `wrangler d1 export` dump into SQL that D1 can actually import.
//
//   node d1-restore-sql.mjs <dump.sql | dump.sql.gz>  > restore.sql
//
// Why this exists: the export does not order tables parent-first, and D1 always
// enforces foreign keys (it ignores `PRAGMA foreign_keys=OFF`), so importing the raw
// dump can stop at "no such table: main.<parent>". This loads the dump into an
// in-memory SQLite with enforcement off, then writes every table back out parents
// first. SQLite's own quote() produces the literals, so text, blobs, NULLs and numbers
// keep their exact values. Nothing here talks to Cloudflare.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";

const ident = (name) => `"${name.replaceAll('"', '""')}"`;

const readDump = (path) => {
  const raw = readFileSync(path);
  return (path.endsWith(".gz") ? gunzipSync(raw) : raw).toString("utf8");
};

const tablesOf = (db) =>
  db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
    )
    .all();

const parentsOf = (db, table) =>
  db
    .prepare(`PRAGMA foreign_key_list(${ident(table)})`)
    .all()
    .map((fk) => fk.table)
    .filter((parent) => parent !== table);

// Depth-first, parents before children. A cycle cannot be ordered; its members keep
// their original relative order and are reported so the operator knows.
const parentFirst = (names, parentsByName) => {
  const ordered = [];
  const state = new Map();
  const cyclic = new Set();
  const visit = (name) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") {
      cyclic.add(name);
      return;
    }
    state.set(name, "visiting");
    for (const parent of parentsByName.get(name) ?? []) {
      if (names.includes(parent)) visit(parent);
    }
    state.set(name, "done");
    ordered.push(name);
  };
  for (const name of names) visit(name);
  return { ordered, cyclic: [...cyclic] };
};

const insertsOf = (db, table) => {
  const columns = db
    .prepare(`PRAGMA table_xinfo(${ident(table)})`)
    .all()
    // hidden: 0 = ordinary, 1 = hidden virtual-table column, 2/3 = generated
    .filter((c) => c.hidden === 0)
    .map((c) => c.name);
  if (columns.length === 0) return [];
  const select = columns.map((c) => `quote(${ident(c)}) AS ${ident(c)}`).join(", ");
  const head = `INSERT INTO ${ident(table)} (${columns.map(ident).join(", ")}) VALUES`;
  return db
    .prepare(`SELECT ${select} FROM ${ident(table)} ORDER BY rowid`)
    .all()
    .map((row) => `${head} (${columns.map((c) => row[c]).join(", ")});`);
};

const main = () => {
  const [path] = process.argv.slice(2);
  if (!path) throw new Error("usage: d1-restore-sql.mjs <dump.sql | dump.sql.gz>");

  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  db.exec(readDump(path));

  const tables = tablesOf(db);
  const names = tables.map((t) => t.name);
  const parentsByName = new Map(names.map((name) => [name, parentsOf(db, name)]));
  const { ordered, cyclic } = parentFirst(names, parentsByName);
  const sqlByName = new Map(tables.map((t) => [t.name, t.sql]));

  const out = ["PRAGMA defer_foreign_keys=TRUE;"];
  for (const name of ordered) {
    out.push(`${sqlByName.get(name)};`);
    out.push(...insertsOf(db, name));
  }
  const hasSequence =
    db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name = 'sqlite_sequence'").get() !== undefined;
  if (hasSequence) {
    out.push("DELETE FROM sqlite_sequence;");
    out.push(...insertsOf(db, "sqlite_sequence"));
  }
  const rest = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type IN ('index', 'trigger', 'view') AND sql IS NOT NULL ORDER BY rowid",
    )
    .all();
  out.push(...rest.map((r) => `${r.sql};`));

  const orphans = db.prepare("PRAGMA foreign_key_check").all().length;
  db.close();

  process.stdout.write(`${out.join("\n")}\n`);
  const rows = out.filter((l) => l.startsWith("INSERT INTO")).length;
  console.error(`tables (parents first): ${ordered.join(", ")}`);
  console.error(`${ordered.length} tables, ${rows} rows, ${rest.length} indexes/triggers/views`);
  if (cyclic.length > 0) {
    console.error(`WARNING: foreign-key cycle through ${cyclic.join(", ")}; order is best effort`);
  }
  if (orphans > 0) {
    console.error(`WARNING: ${orphans} row(s) violate a foreign key in the source data; D1 will reject them`);
  }
};

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
