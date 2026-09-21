---
name: cloudflare-workers-host-synthetic-check
description: Catch "the app answers 200 but nobody can log in" within a day, with a credential-free daily check run from the developer's machine by a systemd user timer. Asserts `/health` and — the part that matters — that the WebAuthn `rpId` returned by each app's login-begin endpoint still matches the host it is served from. Use after any account-, domain- or subdomain-level change (a workers.dev subdomain rename silently killed every passkey on two apps for 82 and 85 days while `/health` stayed 200), when several small passkey apps share one Cloudflare account, or when the only monitoring is "someone will tell me". Since 0.2.0 it also checks **pipelines**: when app A pushes to app B from a Cron Trigger, yesterday's activity on A must have arrived on B (two read-only SQL counts against the production D1 databases through the host's `wrangler login`) — the check that would have caught a nightly push that failed for 16 days with a 404 that never reached the receiver (Cloudflare error 1042). Covers the rpId suffix rule, the `Origin` header that a CSRF check demands on the probe, why the alert should fire during the day, and and why "arrived" must mean a row created AFTER the day closed (a hand-written row with the same tag was once mistaken for proof that the Cron worked).
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets a Linux host with systemd user units and Node 20+ (global `fetch`, `AbortSignal.timeout`). The app checks call only public endpoints. Pipelines additionally need each project's `node_modules/.bin/wrangler` and a host-side `wrangler login` (read-only `d1 execute --remote`); nothing is stored.
metadata:
  author: okayus
  version: "0.2.0"
---

# Daily synthetic check from the host

**The shape in one sentence**: a systemd user timer runs a 100-line Node script once a day that GETs each app's `/health` and POSTs its passkey login-begin endpoint, and raises a desktop notification when the `rpId` in the response is not the host the app is served from.

## Why `/health` is not enough

A WebAuthn credential is bound to the relying party ID. When the page's host stops matching the configured `RP_ID`, the browser refuses both `navigator.credentials.get()` and `.create()` with `SecurityError: The relying party ID is not a registrable domain suffix of, nor equal to the current domain`. The server never sees a failing request, so logs, `/health` and uptime checks stay green.

Measured cost (2026-06-12 → 2026-09): renaming the account's workers.dev subdomain left one app's `RP_ID` on the old name. A family could not log in for up to 82 days; a second app was broken for about 85 days and was only found by accident during unrelated work. Both would have been reported the next morning by the check below.

## Deliverables

- [ ] `~/.config/app-check/{app-check.mjs,apps.json}` installed (`0700` directory)
- [ ] `node ~/.config/app-check/app-check.mjs` prints `ok` for every app
- [ ] The failure path has been seen once (point an entry at a local fake that returns another `rpId`)
- [ ] Every Cron-driven push between your apps has a `pipelines` entry, tried once with `--date=` on a day known to have failed and once on a quiet day
- [ ] `app-check.timer` enabled and one run under systemd is green (pipelines need the unit's `Environment=PATH=…`, see the unit file)

## Install

```sh
SKILL=~/.claude/skills/cloudflare-workers-host-synthetic-check
install -d -m 700 ~/.config/app-check
install -m 644 $SKILL/scripts/app-check.mjs ~/.config/app-check/
$EDITOR ~/.config/app-check/apps.json
node ~/.config/app-check/app-check.mjs

install -m 644 $SKILL/systemd/app-check.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now app-check.timer
systemctl --user start app-check.service && journalctl --user -u app-check.service -n 10 -o cat
```

`apps.json`:

```json
{
  "apps": [
    { "app": "myapp", "origin": "https://myapp.example.workers.dev", "health": "/health", "passkeyBegin": "/api/auth/login/begin" },
    { "app": "oauth-app", "origin": "https://other.example.workers.dev", "health": "/health" }
  ]
}
```

`passkeyBegin` is whichever unauthenticated route returns `PublicKeyCredentialRequestOptions` (`/login/begin`, `/login/options`, …). The script looks for `rpId` anywhere in the JSON, so both `{ rpId }` and `{ options: { rpId } }` work. Leave it out for apps without passkeys.

## Pipelines: did yesterday's push arrive?

A Cron Trigger that POSTs to a sibling app is invisible from outside: the sender logs a status nobody reads, the receiver sees nothing, and unit tests replace `fetch`. Measured: a nightly digest "went live" and never arrived once in 16 days (Cloudflare error 1042 — `cloudflare-workers-pat-bearer-auth` ≥ 0.3.0 has the cause). The assertion that catches every variant of that failure is about data, not logs:

> if the sender had activity yesterday, the receiver has a row for yesterday **created after the day closed**.

```json
{
  "apps": [ … ],
  "pipelines": [
    {
      "name": "quiz-app -> diary daily digest",
      "utcOffsetHours": 9,
      "sender":   { "cwd": "~/src/quiz/apps/web",  "database": "quiz-db",
                    "activitySql": "SELECT COUNT(*) AS n FROM answer WHERE answered_at >= :start AND answered_at < :end" },
      "receiver": { "cwd": "~/src/diary/apps/web", "database": "diary-db",
                    "arrivedSql": "SELECT COUNT(*) AS n FROM post p JOIN post_tags pt ON pt.post_id = p.id JOIN tag t ON t.id = pt.tag_id WHERE t.norm = 'quiz-app' AND p.first_day = :date AND p.created_at >= :end" }
    }
  ]
}
```

- `:start` / `:end` are the epoch-ms bounds of yesterday at `utcOffsetHours`, `:date` is `'YYYY-MM-DD'`. Each SQL returns one row with a numeric column `n`.
- `activitySql` must mirror the sender's own "is there anything to send" rule, or a quiet day reads as a failure.
- **`arrivedSql` must require `created_at >= :end`.** A row for that day that a human wrote during the day is not the Cron's. Two such rows were once taken as proof that the push worked; their `created_at` was 17:30 and 23:56, the Cron runs at 00:15.
- No activity → `ok … no activity on the sender`. Activity and nothing arrived → `FAIL` + notification. `node app-check.mjs --date=2026-09-15` judges a past day (use it once on a day you know failed, and once on a quiet day).
- Pipelines run only on a full run (`app-check.mjs` with no app names).
- Cost: two `wrangler d1 execute --remote` SELECTs a day. They are ordinary queries, not exports, so they do not block the database.

## Traps

1. **The rpId rule is "equal or registrable suffix", not "equal".** `app.example.com` served with `rpId: "example.com"` is valid; the script accepts `host === rpId || host.endsWith("." + rpId)`. It does not consult the public-suffix list, so `rpId: "workers.dev"` would pass here while a browser rejects it. Nobody configures that by accident; the failure this exists for is a stale full hostname.
2. **Send `Origin`.** Apps that require `Origin === ORIGIN` on non-GET `/api/*` answer 403 to a bare `curl -X POST`. The script sends `origin: <origin>`.
3. **One probe a day stays far below an auth rate limit.** Do not turn this into a minute-level uptime monitor: the login-begin route is exactly the one that is rate limited per IP, and a challenge-issuing endpoint is not a health endpoint.
4. **Schedule it for the day.** The alert is `notify-send`; a 04:00 notification on a sleeping machine is read by nobody. `Persistent=true` covers days the machine was off. For alerts when nobody is logged in, set `APP_CHECK_DISCORD_WEBHOOK` in the unit (`Environment=`) and `loginctl enable-linger $USER`.
5. **Add the app on the day it gets its first passkey**, not later. The check is only as complete as `apps.json`.

## What this does not see

- **Why a push failed.** A pipeline check says "nothing arrived", a day late. The reason (400 after a contract change, 404 from error 1042, 401 from a wrong secret) is only in the sender's log, so the sender should log the response body on non-2xx, and ideally report it somewhere a human looks (`cloudflare-cron-to-discord`). Pin the contract with a generated schema (`cloudflare-workers-pat-bearer-auth`).
- **Whether a passkey ceremony completes.** That needs a browser with a virtual authenticator (`cloudflare-workers-e2e-playwright`) and belongs in e2e, not here.

## When you change something account-wide

Before renaming a subdomain, moving to a custom domain, or changing an OAuth callback host: `grep -rn "<old-host>" ~/src/*/` across **every** repo, not just the one you are in. `RP_ID`, `ORIGIN`, OAuth callbacks, firewall allowlists and notification links all carry the host name, and a passkey app cannot change `RP_ID` without re-registering every user.
