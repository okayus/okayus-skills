# Operations: Discord webhook workflow, secrets, diagnosis

Full operational runbook for Discord webhook setup, secret installation, the symptom matrix for "why isn't it working", and the rotation procedure.

## Creating the two Discord webhooks

**Pre-req**: Discord server admin or "Manage Webhooks" permission on the target channels.

### 1. Channels

Create (or identify) two channels:

- Dev: `#<project>-dev` (often a private channel just for yourself)
- Prod: `#<project>` (wherever real notifications land)

**They must be different channels.** Do not point both webhooks at the same channel.

### 2. Dev webhook

1. Right-click the dev channel → **Edit Channel** → **Integrations** → **Webhooks** → **New Webhook**
2. Rename the webhook to exactly: `<project-name> (dev)`
3. Confirm the channel is `#<project>-dev`
4. Click **Copy Webhook URL**
5. **Save Changes**

Paste the URL into `packages/web/.dev.vars`:

```
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/<id>/<token>
```

Confirm `.dev.vars` is gitignored:

```bash
git check-ignore packages/web/.dev.vars
# Expected output: packages/web/.dev.vars
# Empty output = NOT ignored = stop immediately, fix .gitignore
```

### 3. Prod webhook

Same procedure on the prod channel:

1. Right-click the prod channel → Edit Channel → Integrations → Webhooks → New Webhook
2. Rename to exactly: `<project-name> (prod)`
3. Copy URL
4. **Save Changes**

Install as a production secret:

```bash
cd packages/web
pnpm exec wrangler secret put DISCORD_WEBHOOK_URL
# Paste the prod URL at the prompt.
```

Verify it's installed:

```bash
pnpm exec wrangler secret list
# Expected: array includes { "name": "DISCORD_WEBHOOK_URL", "type": "secret_text" }
```

### Why the naming matters

The webhook **value** (URL) is only visible during creation. `wrangler secret list` shows names, never values. If you mix up which URL went where, you can't tell from the CLI.

But: when a webhook posts a message to Discord, the message is tagged with the webhook's **name**. If a message from "`routine-tasks (dev)`" appears in the prod channel, you've cross-contaminated. You can detect and fix it.

Without naming discipline, contamination is invisible until users complain.

## Cron schedule choice

`wrangler.jsonc`:

```jsonc
"triggers": {
  "crons": ["15 * * * *"]  // minute 15 of every hour, UTC
}
```

**Avoid `0 * * * *`** (top of the hour) if you can. Everyone uses it; cross the "thundering herd" effect means Cloudflare may queue a lot of tasks at that moment. Shifting to minute 15 gets you a less-contended slot and also makes testing faster (don't have to wait for the next top-of-hour).

Cron syntax is standard: `minute hour day-of-month month day-of-week`. All in UTC. Cloudflare docs: <https://developers.cloudflare.com/workers/configuration/cron-triggers/>

## The symptom matrix for "it's not working"

When scheduling-to-Discord goes wrong, figure out what you're seeing before debugging. Run `wrangler tail` and also watch both Discord channels.

| Local dev ch | Prod ch | Likely cause | Next step |
|---|---|---|---|
| ✓ | ✓ | Nothing wrong | You're done |
| ✓ | ✗ | Prod secret wrong, deploy not reflected, or Cron not firing in prod | B-1 → B-2 → B-3 below |
| ✗ | ✓ | `.dev.vars` missing / wrong, OR no local scheduled endpoint (0.1.x baseline) | Verify `.dev.vars`; on current toolchains use `/cdn-cgi/handler/scheduled` (see below) |
| ✗ | ✗ | Code-level issue, or webhook URL itself invalid | Check `pnpm test`, then webhook URL validity |
| Dev msg → prod ch | — | `.dev.vars` has prod URL (you pasted prod URL into dev) | Re-paste correct URL to `.dev.vars`, consider rotating prod webhook (dev may have logged prod URL) |
| Prod msg → dev ch | — | Prod secret has dev URL | `wrangler secret put DISCORD_WEBHOOK_URL` with correct prod URL, verify via manual trigger |

### B-0: Check the current state

```bash
# Watch prod logs in real-time (alongside your local dev)
cd packages/web
pnpm exec wrangler tail
```

Watch for `[cron] fired at ...`. If it never appears even at the scheduled time, Cron isn't firing.

### B-1: Secret existence + value check

```bash
pnpm exec wrangler secret list
# Must contain DISCORD_WEBHOOK_URL
```

**Secret value check** — there's no direct way to read it. Indirect options:

- **Fast**: add a **temporary authenticated fetch endpoint** that calls the same code path as `scheduled()`, and curl it while `wrangler tail` runs — you'll see any `[discord] non-2xx` / `[discord] fetch failed` within seconds, and which Discord channel received the message (wrong channel = wrong secret value). Remove the endpoint afterwards. This is the pattern Cloudflare itself recommends: the Dashboard has **no** manual cron-fire button (the feature request was closed NOT_PLANNED — workers-sdk#3377, re-verified 2026-08-08)
- **Slow**: Wait for the next scheduled fire and observe which channel receives

If the message lands in the dev channel, the prod secret has the dev URL. Fix:

```bash
pnpm exec wrangler secret put DISCORD_WEBHOOK_URL
# Paste the correct prod URL.
```

### B-2: Deploy reflection check

`gh run list --workflow=deploy.yml --limit 1` showing "success" doesn't guarantee the latest code is active. Verify:

```bash
pnpm exec wrangler deployments list
```

Take the Version ID from the most recent deployment. Compare its `Created` timestamp with your PR merge time — deploy should be after merge.

For extra confidence, check what the bundle contains:

```bash
pnpm exec wrangler versions view <version-id> 2>&1 | head -50
# Look for: "Handlers:  fetch, scheduled" and any DISCORD_WEBHOOK_URL mention in secrets
```

(Note: `wrangler@3.x` uses `wrangler deployments view`; `4.x` renamed it to `wrangler versions view`. Your version will say if you've got the wrong command.)

### B-3: Cron fire detection

`wrangler tail` is real-time only — it doesn't show past events. For past cron fires, enable Dashboard Observability:

1. Dashboard → Workers & Pages → `<project>` → **Observability** tab → **Enable**
2. Wait for the next fire (or curl your temporary fetch endpoint, if you added one — the Dashboard has no manual cron-fire button)
3. Filter invocations by `Event Type = Scheduled`

Observability doesn't have retroactive data for fires that happened before enabling it.

### B-4: Discord 4xx/5xx decoding

When `[discord] non-2xx response` appears in logs, the status code tells you:

| Status | Meaning | Fix |
|---|---|---|
| 401 | Webhook token invalid (rotated / revoked) | Rotate webhook (below) |
| 404 | Webhook ID itself deleted | Create new webhook, `wrangler secret put` to install |
| 429 | Rate-limited (shouldn't happen at 1/hr or less) | Check for duplicate cron entries in `wrangler.jsonc` |
| 400 | Payload format error | Rare with plain `{content}`. Add debug log: `console.log("[payload]", JSON.stringify(payload))` before posting, redeploy, inspect |
| 5xx | Discord side error | Wait; next Cron fire retries implicitly |

### B-5: Fetch rejection decoding

`[discord] fetch failed <error>`:

- `TypeError: fetch failed` with DNS → Discord DNS unreachable (extremely rare from Cloudflare edge)
- `TypeError: ssl` → TLS handshake problem
- Timeout → Network congestion

All of these resolve themselves in the next Cron fire (Cloudflare routes heal quickly). If sustained, check <https://status.discord.com> and <https://www.cloudflarestatus.com>.

## Webhook rotation procedure

If a webhook URL leaks (accidentally committed, shared in chat, logged somewhere), rotate immediately.

### 1. Revoke old webhook in Discord

Discord channel → Edit Channel → Integrations → Webhooks → the affected webhook → **Delete** (not just edit — the URL stays valid until deleted).

### 2. Create replacement webhook

Same channel, same name (e.g., `<project-name> (prod)`).

### 3. Install new URL

For prod:

```bash
cd packages/web
pnpm exec wrangler secret put DISCORD_WEBHOOK_URL
# Paste new URL.
```

For dev, edit `.dev.vars` and save.

### 4. Verify reflection

`wrangler secret put` is near-instant (a few seconds to propagate). After 30 seconds, manually trigger:

Fire the handler (temporary fetch endpoint, or wait for the next schedule — the Dashboard has no manual cron-fire button). Confirm `wrangler tail` shows no `[discord] non-2xx`, and the correct channel receives the message.

If old behavior (401) persists past 30 seconds, force a redeploy:

```bash
pnpm --filter @<scope>/web run deploy
```

This rebuilds and re-uploads the Worker, forcing a fresh isolate that reads the new secret.

### 5. Document in status.md

Record webhook rotation in the project's `docs/status.md` operational notes. Include:

- Date of rotation
- Reason (leak / scheduled / compromise)
- Old webhook status (Deleted / marked as revoked)

Rotation tracking helps spot patterns (e.g., if rotations happen more than yearly without a leak, something's off).

## Local Cron testing in detail

### What works on current toolchains (verified 2026-08-07)

Both `wrangler dev` (default `:8787`) and `@cloudflare/vite-plugin@1.x` (default `:5173`) expose the official local test endpoint:

```bash
curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=15+*+*+*+*"
```

The `cron` query param should match an expression in `triggers.crons`. `wrangler dev` can additionally fire the handler interactively with the `s` hotkey. Source: <https://developers.cloudflare.com/workers/configuration/cron-triggers/>.

### What doesn't work (`@cloudflare/vite-plugin@0.1.x` legacy)

`@cloudflare/vite-plugin@0.1.21` (the baseline that shipped with `wrangler@3.x`) implements **no** local Cron endpoint — neither the old `/__scheduled` nor the current path. A curl:

```bash
curl -i "http://localhost:5173/__scheduled?cron=0+*+*+*+*"
```

Returns `200 OK` but the body is the SPA HTML (`<h1>...</h1>`), not the cron handler output. The scheduled handler is never called.

Confirm the plugin version you have:

```bash
grep -A 1 '@cloudflare/vite-plugin' pnpm-lock.yaml | head -5
```

### Options

**Option A — skip local, rely on tests + production verification** (for the 0.1.x baseline when you won't bump):

- Run `pnpm test` (10 green) to prove the logic is correct
- After deploying, watch `wrangler tail` for the next Cron fire
- Trigger via Dashboard → Triggers → "Send event" for immediate verification without waiting

This is what the reference `routine-tasks` project uses.

**Option B — bump `@cloudflare/vite-plugin` to 1.x**:

```bash
pnpm --filter @<scope>/web update @cloudflare/vite-plugin --latest
```

Result: bumps to something like `^1.33`. But:

```
 WARN  Issues with peer dependencies found
 └── ✕ unmet peer wrangler@^4.x: found 3.x
 └── ✕ unmet peer workerd@...: found older
```

To satisfy peers, also update:

```bash
pnpm --filter @<scope>/web update wrangler --latest
```

Which bumps to `^4.x`. Then update any wrangler command in docs / scripts:

- `wrangler deployments view` → `wrangler versions view`
- Other renames — see <https://developers.cloudflare.com/workers/wrangler/migration/update-v3-to-v4/>

**When is Option B worth it?** When you're iterating heavily on Cron schedule changes or testing Cron-triggered D1 queries locally, Option A's "deploy and see" loop becomes slow. Otherwise Option A is cheaper.

**Option C — `wrangler dev` in parallel with `vite dev`** (legacy):

You can run `wrangler dev` separately (typically port 8787) while `vite dev` is on 5173. `wrangler dev` hits the actual Worker and does implement the local scheduled endpoint (`/cdn-cgi/handler/scheduled` on wrangler 4; `/__scheduled` in the wrangler 3 era). But routing requests between the two ports is painful, and not worth setting up for most cases. Mentioned for completeness.

## Secret value check: is my prod secret correct?

Again — no direct way. The full procedure:

1. Make sure `pnpm exec wrangler secret list` shows `DISCORD_WEBHOOK_URL`
2. Fire the scheduled handler (temporary fetch endpoint calling the same code path, or wait for the next schedule — no manual Dashboard button exists)
3. Watch `wrangler tail` for `[cron] fired at ...` and any `[discord] non-2xx`
4. Watch both Discord channels — which one receives the message?
5. Correct channel → secret is right. Wrong channel → secret has the other URL; rotate

If you do this right after deploying, steps 2-5 take about 30 seconds.
