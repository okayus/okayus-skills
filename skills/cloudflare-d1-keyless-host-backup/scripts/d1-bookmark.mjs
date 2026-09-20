#!/usr/bin/env node
// Record a D1 Time Travel bookmark right before merging a migration PR, so there is a
// named point to restore to while Time Travel still has it (Free: 7 days, Paid: 30).
//
//   node d1-bookmark.mjs <app>            # print the current bookmark
//   node d1-bookmark.mjs <app> <pr>       # ...and post it as a comment on that PR
//
// Same config as d1-backup.mjs. Posting needs "repo" ("owner/name") on the entry and a
// logged-in `gh` on the host.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH =
  process.env.D1_BACKUP_CONFIG ?? join(homedir(), ".config/d1-backup/databases.json");

const expandHome = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

const findEntry = (app) => {
  const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  const entry = config.databases.find((d) => d.app === app);
  if (!entry) {
    const known = config.databases.map((d) => d.app).join(", ");
    throw new Error(`"${app}" is not in ${CONFIG_PATH} (known: ${known})`);
  }
  return { ...entry, cwd: expandHome(entry.cwd) };
};

const currentBookmark = ({ cwd, database }) => {
  const bin = join(cwd, "node_modules/.bin/wrangler");
  if (!existsSync(bin)) throw new Error(`${bin} not found`);
  const r = spawnSync(bin, ["d1", "time-travel", "info", database], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  if (r.status !== 0) throw new Error(`wrangler exited ${r.status}\n${out.trim()}`);
  // Bookmarks look like 00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683
  const bookmark = out.match(/\b[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{32}\b/)?.[0];
  if (!bookmark) throw new Error(`no bookmark found in wrangler output:\n${out.trim()}`);
  return bookmark;
};

const commentBody = ({ database }, bookmark, takenAt) =>
  [
    "**D1 Time Travel bookmark (taken before merge)**",
    "",
    `- database: \`${database}\``,
    `- taken at: ${takenAt}`,
    `- bookmark: \`${bookmark}\``,
    "",
    "Restore (the restore itself returns a bookmark, so it can be undone):",
    "",
    "```sh",
    `./node_modules/.bin/wrangler d1 time-travel restore ${database} --bookmark=${bookmark}`,
    "```",
    "",
    "Time Travel keeps 7 days on the Free plan, 30 on Paid. After that only the weekly dump remains.",
  ].join("\n");

const main = () => {
  const [app, pr] = process.argv.slice(2);
  if (!app) throw new Error("usage: d1-bookmark.mjs <app> [pr-number]");
  const entry = findEntry(app);
  const takenAt = new Date().toISOString();
  const bookmark = currentBookmark(entry);
  console.log(`${entry.database} @ ${takenAt}\n${bookmark}`);
  if (!pr) return;
  if (!entry.repo) throw new Error(`"repo" is not set for ${app} in ${CONFIG_PATH}`);
  const r = spawnSync(
    "gh",
    ["pr", "comment", String(pr), "--repo", entry.repo, "--body", commentBody(entry, bookmark, takenAt)],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`gh pr comment failed: ${(r.stderr ?? "").trim()}`);
  console.log(`commented on ${entry.repo}#${pr}`);
};

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
