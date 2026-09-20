#!/usr/bin/env node
// Daily synthetic check of deployed apps, from the developer's machine. No credential:
// it only calls public endpoints.
//
//   node app-check.mjs            # every app in the config
//   node app-check.mjs nyalog     # only these
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
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const CONFIG_PATH = process.env.APP_CHECK_CONFIG ?? join(homedir(), ".config/app-check/apps.json");
const TIMEOUT_MS = 20_000;

const readConfig = (path) => {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw.apps) || raw.apps.length === 0) {
    throw new Error(`${path}: "apps" must be a non-empty array`);
  }
  return raw.apps.map((a) => {
    if (!a.app || !a.origin) throw new Error(`${path}: every entry needs "app" and "origin"`);
    return { app: a.app, origin: a.origin.replace(/\/$/, ""), health: a.health ?? null, passkeyBegin: a.passkeyBegin ?? null };
  });
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
  const wanted = process.argv.slice(2);
  const apps = readConfig(CONFIG_PATH).filter((a) => wanted.length === 0 || wanted.includes(a.app));
  if (apps.length === 0) throw new Error(`nothing to check (asked for: ${wanted.join(", ")})`);

  const results = await Promise.all(apps.map(checkApp));
  for (const r of results) {
    console.log(
      r.problems.length === 0
        ? `ok    ${r.app}: ${r.checked.join(", ")}`
        : `FAIL  ${r.app}: ${r.problems.join(" | ")}`,
    );
  }
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
