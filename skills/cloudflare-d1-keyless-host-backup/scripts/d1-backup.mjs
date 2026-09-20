#!/usr/bin/env node
// Keyless, host-side Cloudflare D1 backup. No API token is stored anywhere: it
// reuses the host's existing `wrangler login` (OAuth), runs the wrangler that the
// project already has in node_modules, and keeps the dumps OUTSIDE every repo.
//
//   node d1-backup.mjs                 # every database in the config
//   node d1-backup.mjs kokemusu nyalog # only these apps
//   node d1-backup.mjs --list          # show what is configured and what exists
//
// Config: ~/.config/d1-backup/databases.json (override: D1_BACKUP_CONFIG). See SKILL.md.
// Exit code is non-zero when any database failed, so the systemd unit shows `failed`.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";

const CONFIG_PATH =
  process.env.D1_BACKUP_CONFIG ?? join(homedir(), ".config/d1-backup/databases.json");
const EXPORT_TIMEOUT_MS = 10 * 60 * 1000;
// A table that had at least this many rows and lost more than half of them since the
// previous dump is reported. Catches a silent mass delete (e.g. an unintended CASCADE)
// while Time Travel can still undo it.
const SHRINK_MIN_ROWS = 20;

const expandHome = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

// "2026-09-20T04:40:12.345Z" -> "20260920-044012" (UTC; sorts lexicographically)
const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

const readConfig = (path) => {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw.databases) || raw.databases.length === 0) {
    throw new Error(`${path}: "databases" must be a non-empty array`);
  }
  return {
    outDir: expandHome(raw.outDir ?? "~/backups/d1"),
    keep: Number.isInteger(raw.keep) && raw.keep > 0 ? raw.keep : 26,
    databases: raw.databases.map((d) => {
      if (!d.app || !d.cwd || !d.database) {
        throw new Error(`${path}: every entry needs "app", "cwd" and "database"`);
      }
      return { app: d.app, cwd: expandHome(d.cwd), database: d.database, repo: d.repo ?? null };
    }),
  };
};

// The project's own wrangler, called directly. Never `pnpm exec` / `npx` on the host:
// pnpm 11 re-installs on a store mismatch and wrecks the container's node_modules.
const wranglerBin = (cwd) => join(cwd, "node_modules/.bin/wrangler");

const exportDatabase = ({ cwd, database }, outFile) => {
  const bin = wranglerBin(cwd);
  if (!existsSync(bin)) {
    return { ok: false, error: `${bin} not found (run the project's install in its container)` };
  }
  const r = spawnSync(bin, ["d1", "export", database, "--remote", `--output=${outFile}`], {
    cwd,
    encoding: "utf8",
    timeout: EXPORT_TIMEOUT_MS,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
  });
  if (r.error) return { ok: false, error: String(r.error.message ?? r.error) };
  if (r.status !== 0) {
    const tail = `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim().split("\n").slice(-12).join("\n");
    return { ok: false, error: `wrangler exited ${r.status}\n${tail}` };
  }
  if (!existsSync(outFile) || statSync(outFile).size === 0) {
    return { ok: false, error: "wrangler exited 0 but wrote no dump" };
  }
  return { ok: true };
};

// Restore rehearsal: load the dump into an in-memory SQLite, count rows per table, and
// check integrity. A dump that cannot be loaded is not a backup. Skipped (not fatal)
// when node:sqlite is unavailable.
//
// Foreign keys are OFF while loading on purpose: `wrangler d1 export` does not order
// tables parent-first (measured 2026-09-20: `credential` rows come before `CREATE TABLE
// user`), so with enforcement on the load dies with "no such table: main.user" no matter
// what `PRAGMA defer_foreign_keys` says. The data is then checked with
// `foreign_key_check`. To restore into D1 (enforcement always on) use d1-restore-sql.mjs.
const rehearse = async (sql) => {
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch {
    return { loaded: null, tables: {}, note: "node:sqlite unavailable; dump not rehearsed" };
  }
  const db = new sqlite.DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
  try {
    db.exec(sql);
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => row.name);
    const tables = Object.fromEntries(
      names.map((name) => [
        name,
        Number(db.prepare(`SELECT COUNT(*) AS c FROM "${name.replaceAll('"', '""')}"`).get().c),
      ]),
    );
    const orphans = db.prepare("PRAGMA foreign_key_check").all().length;
    const integrity = db
      .prepare("PRAGMA integrity_check")
      .all()
      .map((row) => String(Object.values(row)[0]));
    const problems = [
      ...(orphans > 0 ? [`${orphans} row(s) violate a foreign key`] : []),
      ...(integrity.join() === "ok" ? [] : [`integrity_check: ${integrity.slice(0, 3).join("; ")}`]),
    ];
    return { loaded: true, tables, problems };
  } catch (e) {
    return { loaded: false, tables: {}, note: `dump did not load into SQLite: ${e.message}` };
  } finally {
    db.close();
  }
};

const shrunkTables = (previous, current) =>
  Object.entries(previous ?? {})
    .filter(([name, before]) => before >= SHRINK_MIN_ROWS && (current[name] ?? 0) < before / 2)
    .map(([name, before]) => `${name}: ${before} -> ${current[name] ?? 0}`);

const dumpsOf = (dir, database) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.startsWith(`${database}-`) && f.endsWith(".sql.gz"))
        .sort()
    : [];

const prune = (dir, database, keep) => {
  const old = dumpsOf(dir, database).slice(0, -keep);
  for (const f of old) rmSync(join(dir, f));
  return old.length;
};

const notify = (title, body) => {
  // Desktop notification; harmless when there is no session bus.
  spawnSync("notify-send", ["--urgency=critical", "--app-name=d1-backup", title, body], {
    stdio: "ignore",
  });
  const hook = process.env.D1_BACKUP_DISCORD_WEBHOOK;
  if (!hook) return Promise.resolve();
  return fetch(hook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: `**${title}**\n${body}`.slice(0, 1900) }),
  }).catch(() => {});
};

const shrinkReport = (previousRun, entry, tables) => {
  const before = previousRun?.results?.find((r) => r.app === entry.app && r.ok)?.tables;
  return shrunkTables(before, tables);
};

const backupOne = async (entry, config, previousRun, now) => {
  const dir = join(config.outDir, entry.app);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(tmpdir(), `d1-backup-${entry.app}-${process.pid}.sql`);
  try {
    const exported = exportDatabase(entry, tmp);
    if (!exported.ok) return { ...entry, ok: false, error: exported.error };

    const sql = readFileSync(tmp, "utf8");
    if (!/CREATE TABLE/i.test(sql)) {
      return { ...entry, ok: false, error: "dump contains no CREATE TABLE" };
    }
    const rehearsal = await rehearse(sql);
    const file = join(dir, `${entry.database}-${stamp(now)}.sql.gz`);
    writeFileSync(file, gzipSync(sql, { level: 9 }), { mode: 0o600 });
    chmodSync(file, 0o600);
    // Read back what was written: the file on disk is the thing being trusted later.
    if (gunzipSync(readFileSync(file)).length !== Buffer.byteLength(sql)) {
      return { ...entry, ok: false, error: `${file} does not round-trip through gzip` };
    }
    const pruned = prune(dir, entry.database, config.keep);
    const shrunk = shrinkReport(previousRun, entry, rehearsal.tables);
    return {
      ...entry,
      ok: rehearsal.loaded !== false,
      error: rehearsal.loaded === false ? rehearsal.note : null,
      file,
      bytes: statSync(file).size,
      sqlBytes: Buffer.byteLength(sql),
      tables: rehearsal.tables,
      note: rehearsal.loaded === null ? rehearsal.note : null,
      // Production data that is inconsistent is worth a warning, but the dump is still
      // a faithful copy, so it does not fail the run.
      problems: rehearsal.problems ?? [],
      shrunk,
      pruned,
    };
  } finally {
    rmSync(tmp, { force: true });
  }
};

const readPreviousRun = (outDir) => {
  try {
    return JSON.parse(readFileSync(join(outDir, "last-run.json"), "utf8"));
  } catch {
    return null;
  }
};

const list = (config) => {
  for (const d of config.databases) {
    const files = dumpsOf(join(config.outDir, d.app), d.database);
    const newest = files.at(-1) ?? "(none yet)";
    const wrangler = existsSync(wranglerBin(d.cwd)) ? "ok" : "MISSING";
    console.log(`${d.app.padEnd(16)} ${d.database.padEnd(20)} wrangler=${wrangler} dumps=${files.length} newest=${newest}`);
  }
};

const main = async () => {
  const config = readConfig(CONFIG_PATH);
  const args = process.argv.slice(2);
  if (args.includes("--list")) return list(config);

  const wanted = args.filter((a) => !a.startsWith("-"));
  const unknown = wanted.filter((a) => !config.databases.some((d) => d.app === a));
  if (unknown.length > 0) throw new Error(`not in ${CONFIG_PATH}: ${unknown.join(", ")}`);
  const targets = config.databases.filter((d) => wanted.length === 0 || wanted.includes(d.app));

  mkdirSync(config.outDir, { recursive: true, mode: 0o700 });
  chmodSync(config.outDir, 0o700);
  const previousRun = readPreviousRun(config.outDir);
  const now = new Date();

  // One at a time: a running export blocks other requests to that database, and there
  // is no reason to hold several production databases at once.
  const results = [];
  for (const entry of targets) {
    const result = await backupOne(entry, config, previousRun, now);
    results.push(result);
    const rows = Object.values(result.tables ?? {}).reduce((a, b) => a + b, 0);
    console.log(
      result.ok
        ? `ok    ${entry.app}: ${result.file} (${result.bytes} B gz, ${Object.keys(result.tables).length} tables, ${rows} rows)`
        : `FAIL  ${entry.app}: ${result.error}`,
    );
    for (const s of result.shrunk ?? []) console.log(`warn  ${entry.app}: table shrank by more than half: ${s}`);
    for (const p of result.problems ?? []) console.log(`warn  ${entry.app}: ${p}`);
    if (result.note) console.log(`note  ${entry.app}: ${result.note}`);
  }

  // A partial run keeps the previous results of the apps it did not touch.
  const untouched = (previousRun?.results ?? []).filter((r) => !targets.some((t) => t.app === r.app));
  writeFileSync(
    join(config.outDir, "last-run.json"),
    `${JSON.stringify({ at: now.toISOString(), results: [...untouched, ...results] }, null, 2)}\n`,
    { mode: 0o600 },
  );

  const failed = results.filter((r) => !r.ok);
  const shrunk = results.filter((r) => (r.shrunk ?? []).length > 0);
  if (failed.length > 0) {
    await notify(
      `D1 backup failed: ${failed.map((r) => r.app).join(", ")}`,
      failed.map((r) => `${r.app}: ${String(r.error).split("\n")[0]}`).join("\n"),
    );
  }
  if (shrunk.length > 0) {
    await notify(
      `D1 backup: a table lost more than half its rows`,
      shrunk.map((r) => `${r.app}: ${r.shrunk.join("; ")}`).join("\n"),
    );
  }
  const inconsistent = results.filter((r) => (r.problems ?? []).length > 0);
  if (inconsistent.length > 0) {
    await notify(
      `D1 backup: production data failed a consistency check`,
      inconsistent.map((r) => `${r.app}: ${r.problems.join("; ")}`).join("\n"),
    );
  }
  process.exitCode = failed.length > 0 ? 1 : 0;
};

main().catch(async (e) => {
  console.error(`FAIL  ${e.message}`);
  await notify("D1 backup could not start", e.message);
  process.exitCode = 1;
});
