#!/usr/bin/env node
// Daily synthetic check of deployed apps, from the developer's machine. No credential:
// it only calls public endpoints.
//
//   node app-check.mjs                    # every app and every pipeline in the config
//   node app-check.mjs nyalog             # only these apps (pipelines are skipped)
//   node app-check.mjs --date=2026-09-15  # judge pipelines for that day instead of yesterday
//
// Config: ~/.config/app-check/apps.json (override: APP_CHECK_CONFIG). See SKILL.md.
//
// What it asserts per app:
//   health        GET  <origin><health>          -> 200
//   passkeyBegin  POST <origin><passkeyBegin> {} -> JSON whose `rpId` matches the host
//
// The second one exists because `/health` stays 200 while every passkey is dead: a
// WebAuthn rpId that is not the page's host (or a registrable suffix of it) makes the
// browser refuse both login and registration, and nothing server-side notices.
//
// Pipelines ("app A pushes to app B from a Cron Trigger"): yesterday's activity on the
// sender must have arrived on the receiver. Two read-only SQL counts against the two
// production D1 databases, through the host's `wrangler login` — no stored credential.
// This exists because such a push failed every night for 16 days (the sender got a 404
// that never reached the receiver, Cloudflare error 1042) while both apps, their tests
// and their health checks were green.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = process.env.APP_CHECK_CONFIG ?? join(homedir(), ".config/app-check/apps.json");
const TIMEOUT_MS = 20_000;

const expandHome = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

const readConfig = (path) => {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw.apps) || raw.apps.length === 0) {
    throw new Error(`${path}: "apps" must be a non-empty array`);
  }
  const apps = raw.apps.map((a) => {
    if (!a.app || !a.origin) throw new Error(`${path}: every entry needs "app" and "origin"`);
    return { app: a.app, origin: a.origin.replace(/\/$/, ""), health: a.health ?? null, passkeyBegin: a.passkeyBegin ?? null };
  });
  const side = (where, x, sqlKey) => {
    if (!x?.cwd || !x?.database || !x?.[sqlKey]) {
      throw new Error(`${path}: ${where} needs "cwd", "database" and "${sqlKey}"`);
    }
    return { cwd: expandHome(x.cwd), database: x.database, sql: x[sqlKey] };
  };
  const pipelines = (raw.pipelines ?? []).map((p) => ({
    name: p.name ?? "pipeline",
    // The day boundary the sender uses (hours east of UTC). 9 = JST.
    utcOffsetHours: Number.isFinite(p.utcOffsetHours) ? p.utcOffsetHours : 9,
    sender: side(`pipeline "${p.name}" sender`, p.sender, "activitySql"),
    receiver: side(`pipeline "${p.name}" receiver`, p.receiver, "arrivedSql"),
  }));
  return { apps, pipelines };
};

// rpId may sit anywhere in the body ({ rpId } or { options: { rpId } }).
const findRpId = (value) => {
  if (value === null || typeof value !== "object") return undefined;
  if (typeof value.rpId === "string") return value.rpId;
  for (const child of Object.values(value)) {
    const found = findRpId(child);
    if (found !== undefined) return found;
  }
  return undefined;
};

// WebAuthn: the rpId must equal the host or be a registrable domain suffix of it.
const rpIdMatchesHost = (rpId, host) => host === rpId || host.endsWith(`.${rpId}`);

const checkHealth = async ({ origin, health }) => {
  const res = await fetch(`${origin}${health}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  return res.status === 200 ? null : `GET ${health} -> ${res.status}`;
};

const checkPasskeyBegin = async ({ origin, passkeyBegin }) => {
  const host = new URL(origin).hostname;
  const res = await fetch(`${origin}${passkeyBegin}`, {
    method: "POST",
    // Origin: apps with a CSRF check on non-GET /api/* reject a request without it.
    headers: { "content-type": "application/json", origin },
    body: "{}",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status !== 200) return `POST ${passkeyBegin} -> ${res.status}`;
  const rpId = findRpId(await res.json().catch(() => null));
  if (rpId === undefined) return `POST ${passkeyBegin} -> 200 but no rpId in the body`;
  return rpIdMatchesHost(rpId, host)
    ? null
    : `rpId "${rpId}" does not match host "${host}": every passkey login and registration fails in the browser`;
};

const checkApp = async (entry) => {
  const checks = [
    ...(entry.health ? [["health", checkHealth]] : []),
    ...(entry.passkeyBegin ? [["passkeyBegin", checkPasskeyBegin]] : []),
  ];
  const problems = [];
  for (const [name, run] of checks) {
    const problem = await run(entry).catch((e) => `${name}: ${e.message}`);
    if (problem) problems.push(problem);
  }
  return { app: entry.app, checked: checks.map(([name]) => name), problems };
};

// [startMs, endMs) and "YYYY-MM-DD" of a calendar day at a fixed UTC offset. `date`
// null = the day that finished most recently before now.
const dayWindow = (date, utcOffsetHours, nowMs) => {
  const offset = utcOffsetHours * 3600_000;
  const DAY = 86_400_000;
  const dayIndex = date ? Date.parse(`${date}T00:00:00Z`) / DAY : Math.floor((nowMs + offset) / DAY) - 1;
  const startMs = dayIndex * DAY - offset;
  return { startMs, endMs: startMs + DAY, date: new Date(dayIndex * DAY).toISOString().slice(0, 10) };
};

// The SQL comes from the operator's own config; the three values are produced here
// (two integers and a validated date), so plain substitution is safe.
const bindSql = (sql, { startMs, endMs, date }) =>
  sql.replaceAll(":start", String(startMs)).replaceAll(":end", String(endMs)).replaceAll(":date", `'${date}'`);

// One read-only count through the project's own wrangler (never `pnpm exec` / `npx` on
// the host). The SQL must return a single row with a column named `n`.
const d1Count = ({ cwd, database, sql }, window) => {
  const bin = join(cwd, "node_modules/.bin/wrangler");
  if (!existsSync(bin)) throw new Error(`${bin} not found`);
  const r = spawnSync(bin, ["d1", "execute", database, "--remote", "--json", "--command", bindSql(sql, window)], {
    cwd,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
  });
  if (r.status !== 0) throw new Error(`wrangler d1 execute ${database} exited ${r.status}: ${(r.stderr ?? "").trim().split("\n").at(-1)}`);
  const n = JSON.parse(r.stdout)?.[0]?.results?.[0]?.n;
  if (typeof n !== "number") throw new Error(`${database}: the SQL must return one row with a numeric column "n"`);
  return n;
};

const checkPipeline = (pipeline, date, nowMs) => {
  const window = dayWindow(date, pipeline.utcOffsetHours, nowMs);
  try {
    const activity = d1Count(pipeline.sender, window);
    if (activity === 0) return { name: pipeline.name, date: window.date, note: "no activity on the sender, nothing to arrive", problems: [] };
    const arrived = d1Count(pipeline.receiver, window);
    return {
      name: pipeline.name,
      date: window.date,
      note: `activity ${activity}, arrived ${arrived}`,
      problems: arrived > 0 ? [] : [`the sender had activity (${activity}) on ${window.date} but nothing arrived on the receiver`],
    };
  } catch (e) {
    return { name: pipeline.name, date: window.date, note: "", problems: [`could not check: ${e.message}`] };
  }
};

const notify = (title, body) => {
  spawnSync("notify-send", ["--urgency=critical", "--app-name=app-check", title, body], { stdio: "ignore" });
  const hook = process.env.APP_CHECK_DISCORD_WEBHOOK;
  if (!hook) return Promise.resolve();
  return fetch(hook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: `**${title}**\n${body}`.slice(0, 1900) }),
  }).catch(() => {});
};

const main = async () => {
  const args = process.argv.slice(2);
  const date = args.find((a) => a.startsWith("--date="))?.slice("--date=".length) ?? null;
  if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date must be YYYY-MM-DD");
  const wanted = args.filter((a) => !a.startsWith("--"));
  const config = readConfig(CONFIG_PATH);
  const apps = config.apps.filter((a) => wanted.length === 0 || wanted.includes(a.app));
  if (apps.length === 0) throw new Error(`nothing to check (asked for: ${wanted.join(", ")})`);

  const appResults = await Promise.all(apps.map(checkApp));
  for (const r of appResults) {
    console.log(
      r.problems.length === 0
        ? `ok    ${r.app}: ${r.checked.join(", ")}`
        : `FAIL  ${r.app}: ${r.problems.join(" | ")}`,
    );
  }
  // Pipelines only on a full run: naming apps means "I am poking at one app".
  const pipelineResults = wanted.length === 0 ? config.pipelines.map((p) => checkPipeline(p, date, Date.now())) : [];
  for (const r of pipelineResults) {
    console.log(
      r.problems.length === 0
        ? `ok    ${r.name} [${r.date}]: ${r.note}`
        : `FAIL  ${r.name} [${r.date}]: ${r.problems.join(" | ")}`,
    );
  }
  const results = [
    ...appResults,
    ...pipelineResults.map((r) => ({ app: `${r.name} [${r.date}]`, problems: r.problems })),
  ];
  const failed = results.filter((r) => r.problems.length > 0);
  if (failed.length > 0) {
    await notify(
      `app-check failed: ${failed.map((r) => r.app).join(", ")}`,
      failed.map((r) => `${r.app}: ${r.problems.join(" | ")}`).join("\n"),
    );
  }
  process.exitCode = failed.length > 0 ? 1 : 0;
};

main().catch(async (e) => {
  console.error(`FAIL  ${e.message}`);
  await notify("app-check could not start", e.message);
  process.exitCode = 1;
});
