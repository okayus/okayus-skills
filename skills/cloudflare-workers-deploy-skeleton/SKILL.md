---
name: cloudflare-workers-deploy-skeleton
description: Set up a Cloudflare Workers "Walking Skeleton" that serves SPA + API + Cron from a single Worker, with D1 migrations and GitHub Actions auto-deploy. Use when starting a new Cloudflare Workers project and you need the full deployment pipeline (wrangler.jsonc, the 3-layer SPA routing dance, deploy.yml, empty D1 migration) wired up with business logic deferred. Covers the setup pitfalls that are easy to lose hours on — D1 token scope, `pnpm deploy` npm-script collision, database_id placeholder, and the RP_ID locking rule for any future WebAuthn use.
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets Cloudflare Workers with Hono + Vite + @cloudflare/vite-plugin + Drizzle (optional) on pnpm workspaces. Requires wrangler CLI and gh CLI.
metadata:
  author: okayus
  version: "0.1.0"
---

# Cloudflare Workers Deploy Skeleton

Get a new Cloudflare Workers project to the state where **`main` push → production URL returns `/health` 200 and serves SPA HTML**, with business logic = zero.

**Why do this first**: Deployment boundaries (`wrangler.jsonc`, GH Actions, D1, Cron registration, SPA routing, secure-headers-ready asset serving) are the most expensive things to debug if they break after a codebase is full. Wire them end-to-end on an empty app, then grow logic on top of proven infrastructure.

## When to use this skill

- Starting a new Cloudflare Workers project where you intend to serve SPA + API + Cron from one Worker
- Re-scaffolding an existing project that grew organically and now has SPA routing / deploy drift issues
- Onboarding a teammate and you need a known-good baseline to reproduce

Do **not** use for multi-Worker microservices, Pages-only sites, or projects that don't need D1.

## Deliverables (completion criteria)

Run through the steps in [references/setup-order.md](references/setup-order.md). You're done when:

1. `curl https://<project>.<cf-subdomain>.workers.dev/health` returns `{"status":"ok"}` with HTTP 200
2. `curl https://<project>.<cf-subdomain>.workers.dev/` returns 200 with SPA HTML containing `<h1>...</h1>`
3. `main` push → GH Actions `deploy.yml` runs D1 migrations → deploys Worker, all green
4. `wrangler d1 migrations list <db> --remote` shows `0000_init` applied
5. `wrangler.jsonc` has both `assets.run_worker_first: true` and `triggers.crons`
6. `.dev.vars` is gitignored, `.dev.vars.example` is committed
7. `database_id` in `wrangler.jsonc` is a real UUID (not a `<placeholder>`)

## The 3-layer SPA routing dance

**This is the thing that breaks silently.** Serving a React SPA + a Hono Worker + preparing for `secureHeaders` to cover the SPA HTML requires **three** pieces to agree. Miss any one → `/` returns 404.

| Layer | Location | Setting | Purpose |
|---|---|---|---|
| L1 | `wrangler.jsonc` | `assets.not_found_handling: "single-page-application"` | Fallback assets to `index.html` |
| L2 | `wrangler.jsonc` | `assets.run_worker_first: true` | Worker sees every request before Assets (lets secureHeaders wrap SPA HTML later) |
| L3 | `worker/index.ts` | `app.notFound(async (c) => new Response((await c.env.ASSETS.fetch(c.req.raw)).body, res))` | Worker explicitly delegates unmatched routes to the Assets binding |

If any layer is missing and `/` returns 404, consult [references/spa-routing-diagnosis.md](references/spa-routing-diagnosis.md).

## Core files (copy from references)

These references contain fully-formed, copy-ready templates. Use them verbatim and change only what's marked `<...>`:

- [`references/wrangler-template.md`](references/wrangler-template.md) — `wrangler.jsonc` with 3-layer SPA + D1 + Cron
- [`references/worker-template.md`](references/worker-template.md) — `worker/index.ts` + `worker/cron.ts` + `worker/types.ts` (single-source `Bindings`)
- [`references/gh-actions-template.md`](references/gh-actions-template.md) — `.github/workflows/deploy.yml` with migrations → deploy ordering + concurrency
- [`references/tsconfig-and-vite.md`](references/tsconfig-and-vite.md) — TypeScript strict config + Vite + `@cloudflare/vite-plugin`
- [`references/d1-scaffold.md`](references/d1-scaffold.md) — empty `drizzle/0000_init.sql` to validate the migration pipeline
- [`references/dev-vars.md`](references/dev-vars.md) — `.dev.vars.example` pattern (keys only, no values)

## Setup flow

High-level — step-by-step with exact commands in [references/setup-order.md](references/setup-order.md):

1. **User (interactive)**: `wrangler login` in a browser
2. **User**: `wrangler d1 create <db-name>` → copy `database_id` UUID
3. **User**: Create CF API token with `Workers Scripts:Edit + D1:Edit + Account Settings:Read + User Details:Read` → GitHub repo secret `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
4. **Agent**: Generate files from references above. **Substitute the real `database_id` UUID immediately**; never leave a `<placeholder>` in `wrangler.jsonc`
5. **Agent**: `pnpm install` → `pnpm check` → `pnpm db:migrate` (local) → verify with a dev run
6. **Agent**: Commit → push → draft PR → user merges → GH Actions runs → observe deploy success
7. **User**: Look up the assigned production URL in CF Dashboard → Triggers → Route
8. **Agent**: Update `wrangler.jsonc` `RP_ID` / `ORIGIN` to the real production hostname → push → re-deploy

## The pitfalls that eat hours

Brief summary; full write-ups in [references/pitfalls.md](references/pitfalls.md):

- **`pnpm deploy` collides** with a pnpm built-in subcommand. In the workspace root's `package.json`, use `"deploy": "pnpm --filter <pkg> run deploy"` with explicit `run`
- **"Edit Cloudflare Workers" API token template lacks `D1:Edit`** → `wrangler d1 migrations apply --remote` fails with error 7403 in CI. Add the D1 permission manually when creating the token
- **`database_id` placeholder** left as `<...>` in `wrangler.jsonc` → deploy fails. Substitute immediately after `wrangler d1 create`, don't defer
- **`RP_ID` locking rule**: If you'll ever use WebAuthn / passkeys, the RP_ID (hostname) **must be locked on first deploy**. Changing it later invalidates every registered credential. Pin to the production `workers.dev` subdomain or your custom domain from day 1, treat as permanent
- **vite-plugin `/__scheduled` dev caveat**: `@cloudflare/vite-plugin@0.1.x` doesn't route `/__scheduled` in dev (falls back to SPA). `1.x` fixes it but requires `wrangler@^4`. For dev Cron testing, see the `cloudflare-cron-to-discord` skill's fallback

## Scope boundary — what this skill does NOT cover

- Authentication (passkeys / sessions / JWT) — deferred to a later phase
- Security hardening (`secureHeaders`, CSP, `app.onError`, `sessionMiddleware`) — build on top of this skeleton in a later phase
- Domain schema (tasks, users, etc.) — defer to when you know what the domain actually looks like
- `drizzle-orm` / `drizzle-kit` — don't install until you have a real schema to generate migrations for. The empty `0000_init.sql` validates the pipeline without forcing a Chekhov's-gun dependency

**Build logic on top after deploy is provably working**, not before.

## References

All references below are concrete, copy-ready templates and diagnostic playbooks:

- [setup-order.md](references/setup-order.md) — end-to-end setup sequence with exact commands
- [wrangler-template.md](references/wrangler-template.md) — `wrangler.jsonc` template
- [worker-template.md](references/worker-template.md) — `worker/index.ts` / `cron.ts` / `types.ts` templates
- [gh-actions-template.md](references/gh-actions-template.md) — `deploy.yml` template
- [tsconfig-and-vite.md](references/tsconfig-and-vite.md) — TypeScript + Vite setup
- [d1-scaffold.md](references/d1-scaffold.md) — empty migration for pipeline validation
- [dev-vars.md](references/dev-vars.md) — `.dev.vars.example` pattern
- [spa-routing-diagnosis.md](references/spa-routing-diagnosis.md) — 3-layer SPA 404 troubleshooting
- [pitfalls.md](references/pitfalls.md) — known setup traps with full write-ups
