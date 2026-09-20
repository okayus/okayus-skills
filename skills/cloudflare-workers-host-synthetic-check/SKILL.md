---
name: cloudflare-workers-host-synthetic-check
description: Catch "the app answers 200 but nobody can log in" within a day, with a credential-free daily check run from the developer's machine by a systemd user timer. Asserts `/health` and — the part that matters — that the WebAuthn `rpId` returned by each app's login-begin endpoint still matches the host it is served from. Use after any account-, domain- or subdomain-level change (a workers.dev subdomain rename silently killed every passkey on two apps for 82 and 85 days while `/health` stayed 200), when several small passkey apps share one Cloudflare account, or when the only monitoring is "someone will tell me". Covers the rpId suffix rule, the `Origin` header that a CSRF check demands on the probe, why the alert should fire during the day, and what this check cannot see (a cross-app POST failing quietly inside a Cron Trigger — that needs the sender to report non-2xx).
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets a Linux host with systemd user units and Node 20+ (global `fetch`, `AbortSignal.timeout`). Calls only public endpoints; stores no credential.
metadata:
  author: okayus
  version: "0.1.0"
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
- [ ] `app-check.timer` enabled and one run under systemd is green

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

## Traps

1. **The rpId rule is "equal or registrable suffix", not "equal".** `app.example.com` served with `rpId: "example.com"` is valid; the script accepts `host === rpId || host.endsWith("." + rpId)`. It does not consult the public-suffix list, so `rpId: "workers.dev"` would pass here while a browser rejects it. Nobody configures that by accident; the failure this exists for is a stale full hostname.
2. **Send `Origin`.** Apps that require `Origin === ORIGIN` on non-GET `/api/*` answer 403 to a bare `curl -X POST`. The script sends `origin: <origin>`.
3. **One probe a day stays far below an auth rate limit.** Do not turn this into a minute-level uptime monitor: the login-begin route is exactly the one that is rate limited per IP, and a challenge-issuing endpoint is not a health endpoint.
4. **Schedule it for the day.** The alert is `notify-send`; a 04:00 notification on a sleeping machine is read by nobody. `Persistent=true` covers days the machine was off. For alerts when nobody is logged in, set `APP_CHECK_DISCORD_WEBHOOK` in the unit (`Environment=`) and `loginctl enable-linger $USER`.
5. **Add the app on the day it gets its first passkey**, not later. The check is only as complete as `apps.json`.

## What this does not see

- **A cross-app call failing inside a Cron Trigger.** If app A POSTs to app B every night and B changed its contract, A gets 400 and, when written fail-quiet, only `console.log`s it. Nothing outside A can observe that. The fix belongs in the sender: report non-2xx somewhere a human looks (`cloudflare-cron-to-discord`), and pin the contract with a generated schema (`cloudflare-workers-pat-bearer-auth` ≥ 0.2.0).
- **Whether a passkey ceremony completes.** That needs a browser with a virtual authenticator (`cloudflare-workers-e2e-playwright`) and belongs in e2e, not here.

## When you change something account-wide

Before renaming a subdomain, moving to a custom domain, or changing an OAuth callback host: `grep -rn "<old-host>" ~/src/*/` across **every** repo, not just the one you are in. `RP_ID`, `ORIGIN`, OAuth callbacks, firewall allowlists and notification links all carry the host name, and a passkey app cannot change `RP_ID` without re-registering every user.
