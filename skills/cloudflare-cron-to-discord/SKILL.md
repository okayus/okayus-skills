---
name: cloudflare-cron-to-discord
description: Wire a Cloudflare Workers Cron Trigger to post to a Discord Webhook using the pure-function-then-boundary architecture. Use when adding scheduled notifications (daily summaries, reminders, health pings) to a Workers app. Covers the domain/boundary split (pure message builder + throw-less boundary sender), environment-timezone-independent UTC→JST conversion, vitest mock testing of the boundary, dev/prod webhook naming discipline that makes cross-contamination detectable, the secret management workflow, and local Cron testing via `/cdn-cgi/handler/scheduled` (plus the legacy `@cloudflare/vite-plugin@0.1.x` caveat, which has no local Cron endpoint at all). Assumes you already have a working Cloudflare Workers skeleton (see cloudflare-workers-deploy-skeleton).
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets Cloudflare Workers with Hono + vitest (Node env). Requires an existing Workers skeleton with a `scheduled` handler and `types.ts` Bindings. Requires Discord server admin or "Manage Webhooks" permission to create webhooks.
metadata:
  author: okayus
  version: "0.1.0"
---

# Cloudflare Cron → Discord Webhook

Send scheduled notifications from a Cloudflare Worker Cron Trigger to a Discord channel, with an architecture that's safe to extend into real domain logic later.

**Prerequisite**: a working Workers skeleton with `scheduled` handler wired (see the `cloudflare-workers-deploy-skeleton` skill).

## When to use

- Daily / hourly / weekly Discord notifications (reminders, summaries, health checks)
- Any scheduled outbound message from Workers to any webhook-style recipient (Discord is the example; the architecture transfers to Slack, Teams, etc. by swapping the HTTP contract)
- As a **walking skeleton** before real domain logic is ready — skeleton message first, then replace the pure builder with real logic later

Do **not** use for:
- High-frequency fanout (Cron trigger is limited to 1-minute granularity)
- Bidirectional Discord interactions (use Discord Bot with Interactions, not webhooks)
- Anything requiring Cron retry semantics (Workers Cron is fire-once-per-schedule; implement retries on top yourself)

## The architecture: pure → boundary

```
scheduled(event, env)
  └─ runScheduled(event, env)
       ├─ buildMessage(now: Date): Payload        ← pure function
       └─ postToDiscord(url, payload): Promise<void>  ← boundary, never throws
```

Two rules:

1. **The builder is pure**. No I/O, no `env`, no clock reads (take `now` as a parameter). This makes it trivially unit-testable and trivially replaceable (Phase N skeleton message → Phase N+1 domain logic).
2. **The sender never throws**. All fetch failures are `console.error`'d and swallowed. Reasons:
   - Cron runs on a schedule. A single failed notification should not prevent the next one.
   - There's no retry semantics to leverage anyway.
   - Throwing from a scheduled handler doesn't help the user — it just shows up as an opaque exception in the Dashboard.

## Core deliverables

1. `worker/time.ts` — pure UTC→JST conversion (or your timezone of choice). Environment-TZ-independent using `getUTC*()` methods
2. `worker/discord.ts` — `buildSkeletonMessage(now)` (pure) + `postToDiscord(url, payload)` (boundary, throw-less)
3. `worker/cron.ts` — wire builder → sender
4. `worker/types.ts` — add `DISCORD_WEBHOOK_URL: string` to `Bindings`
5. vitest setup — `vitest.config.ts` + ten tests (6 time + 4 discord)
6. Production Discord Webhook created and installed via `wrangler secret put DISCORD_WEBHOOK_URL`
7. Development Discord Webhook installed in `.dev.vars` (separate channel from prod)

See [references/implementation.md](references/implementation.md) for the full source code, ready to paste in.

## Dev/prod discipline: webhook naming

**Always create two webhooks in separate Discord channels**:

- `<project-name> (dev)` → channel `#<project>-dev`
- `<project-name> (prod)` → channel `#<project>` (or wherever prod lives)

**Why the naming matters**: webhook values (`https://discord.com/api/webhooks/<id>/<token>`) are not visible after installation (`wrangler secret list` shows names only). If you accidentally put the dev URL into the prod secret (or vice versa), the only way to detect it is to look at where messages actually arrive.

If a message posted by "routine-tasks (dev)" shows up in the prod channel, you've cross-contaminated. Naming the webhooks identifiably makes this detectable in 30 seconds.

Full operational workflow in [references/operations.md](references/operations.md).

## The vitest testing pattern

For the pure builder: standard table-driven tests with known UTC inputs and expected JST output strings.

For the boundary sender: `vi.spyOn(globalThis, "fetch")` to mock fetch, then assert:
- Success path: fetch is called with the right URL and method
- Non-2xx: does NOT throw, logs to `console.error`
- Fetch rejection: does NOT throw, logs to `console.error`

Environment must be `"node"` (not `"jsdom"`), and the `vitest.config.ts` must be **separate from `vite.config.ts`** — loading the `@cloudflare/vite-plugin` into the test runner causes unhelpful dev-server side-effects.

Full test code in [references/testing.md](references/testing.md).

## Production setup flow

High-level; detailed commands in [references/operations.md](references/operations.md):

1. **User**: Create two Discord webhooks with the dev/prod naming discipline above
2. **User**: `wrangler secret put DISCORD_WEBHOOK_URL` and paste the **prod** URL
3. **User**: Copy `.dev.vars.example` → `.dev.vars`, paste the **dev** URL
4. **Agent**: Copy `time.ts` / `discord.ts` / vitest files from references, wire `cron.ts`
5. **Agent**: `pnpm install` → `pnpm check` → `pnpm test` (10/10 green)
6. **Agent**: Commit → push → user merges → auto-deploy
7. **Validate prod**: `wrangler tail` shows `[cron] fired at ...` at scheduled time, Discord prod channel receives `[<project>] cron fired at <JST> (skeleton)` message

## Local Cron testing (`/cdn-cgi/handler/scheduled`)

Current toolchains expose a local test endpoint for the scheduled handler — both `wrangler dev` (default `:8787`) and `@cloudflare/vite-plugin@1.x` (default `:5173`):

```bash
curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=15+*+*+*+*"
```

The `cron` query param should match an expression in `triggers.crons`. In `wrangler dev` you can also press the `s` hotkey to fire the handler interactively. (Source: [Workers Cron Triggers docs](https://developers.cloudflare.com/workers/configuration/cron-triggers/), verified 2026-08-07.)

**Legacy caveat (`@cloudflare/vite-plugin@0.1.x` / wrangler 3 baseline)**: 0.1.x implements **no** local Cron endpoint at all — the old `/__scheduled` path falls through to the SPA HTML. On that baseline, either bump to `vite-plugin@^1` + `wrangler@^4` simultaneously (major version jump, treat as its own task) or skip local Cron testing and rely on vitest mocks + prod verification (`wrangler tail` at the next scheduled fire). Full tradeoffs in [references/operations.md](references/operations.md).

## Diagnosing "prod Discord isn't receiving"

When the cron fires but messages don't land, work the symptom matrix in [references/operations.md](references/operations.md):

| Local dev ch | Prod ch | Likely cause |
|---|---|---|
| ✓ arrives | ✗ nothing | Prod secret wrong, or deploy not reflected yet, or Cron not firing |
| ✗ nothing | ✓ arrives | `.dev.vars` missing, or no local scheduled endpoint on your baseline (see *Local Cron testing*) |
| ✗ nothing | ✗ nothing | Code-level issue (`cron.ts` / `discord.ts` implementation) OR webhook URL itself invalid |
| Dev msg in prod ch | — | `.dev.vars` has prod URL (swap fix + rotate) |
| Prod msg in dev ch | — | Prod secret has dev URL (swap fix + rotate) |

Detailed diagnostic flow in [references/operations.md](references/operations.md) — including Dashboard Observability setup, `wrangler deployments list`-based reflection check, and webhook rotation procedure with reflection-verification.

## Progressive disclosure: when to replace skeleton

When real domain logic arrives (e.g., "notify about unfinished tasks from D1"):

1. Keep the **signatures** of `buildMessage` and `postToDiscord` stable. This is the whole point of the boundary: you don't rewire Cron to swap the logic
2. Replace `buildSkeletonMessage(now)` with `buildNotificationMessage(tasks: Task[], now: Date)` — still pure
3. Update `discord.test.ts` to cover the new builder inputs (table-driven: (tasks, now) → expected payload)
4. Update `cron.ts` to query D1 first, then feed results to the builder

The boundary (`postToDiscord`) stays **exactly the same**. The only thing that changes is what's upstream of it.

## Scope boundary

This skill does **NOT** cover:

- The underlying Workers skeleton (`wrangler.jsonc`, GH Actions, D1) — see `cloudflare-workers-deploy-skeleton`
- Replacing skeleton logic with real domain rules — that's a project-phase decision; the boundary is designed to make it easy
- Discord embeds, mentions, reaction-based interactions — webhooks support them (add `embeds` / `components` fields in the payload) but skeleton uses `content` only
- Non-Discord recipients — the architecture ports to Slack / Teams / generic HTTP recipients; only the payload shape changes
- `neverthrow` / Result-type error handling — deferred; skeleton uses try/catch with `console.error` for simplicity

## References

- [implementation.md](references/implementation.md) — full source of `time.ts`, `discord.ts`, `cron.ts`, `types.ts` addition
- [testing.md](references/testing.md) — `vitest.config.ts`, `time.test.ts`, `discord.test.ts` with fetch-mock pattern
- [operations.md](references/operations.md) — Discord webhook creation steps, dev/prod secret workflow, symptom matrix, diagnostic flow, rotation procedure
