---
name: cloudflare-workers-pat-bearer-auth
description: Add personal access tokens (PATs, Bearer header) to a Hono + D1 Cloudflare Worker so CLIs, AI agents and sibling apps can call the API as a user next to the cookie session — the receiving app mints the token in its settings UI, the caller stores it, and the receiver never needs to know who is calling. Use when building a CLI or an app-to-app push ("post today's quiz results into my diary app"), when a Bearer request gets `403 csrf_origin_mismatch`, when a PAT could mint more PATs, when revoking one token must not log the user out, or when a D1 leak must not yield live credentials. Covers the `<app>_pat_` prefix (greppable; NOT auto-detected by GitHub's free push protection), sha256(token + pepper) with the pepper as a Worker Secret, the validation order that rejects junk before D1, PAT-before-session middleware, scopes as a const tuple, session-only token management, the throttled last_used_at write, the CSRF exemption for Bearer, and pepper rotation. Not Cloudflare API tokens.
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets Cloudflare Workers with Hono 4 + Drizzle ORM + D1 (SQLite) on the cloudflare-workers-deploy-skeleton stack (Vite + @cloudflare/vite-plugin, pnpm), WebCrypto only (no nodejs_compat). Needs an existing cookie-session layer — third-party OAuth (mazuoboeru, `arctic`) or passkeys (cloudflare-workers-passkey-auth); the PAT path sits in front of it. Requires wrangler CLI for `wrangler secret put PAT_PEPPER`.
metadata:
  author: okayus
  version: "0.1.0"
---

# Cloudflare Workers PAT (Bearer) auth for machine callers

Get a Hono + D1 Worker that already has cookie sessions to the state where **a CLI, an AI agent or another app can act as a specific user with a token the user minted in the settings UI** — the token is shown once, only `sha256(token + pepper)` is stored, every existing route accepts either credential, a PAT can never mint another PAT, and revoking one token touches nothing else.

Extracted from mazuoboeru (ADR-0001, `worker/auth/pat.ts`; in production since Phase 1, 2026-06; the `mzo` CLI on npm has used it since 2026-08-13), 2026-08-22. The first *receiver-side* consumer planned is kokemusu (`POST /api/posts` behind `post:write`).

**The shape in one sentence**: the **receiving** app issues the token (session-only route), the **calling** side stores it (env var, another Worker's secret) and sends `Authorization: Bearer <token>`, and the receiver's auth middleware tries the PAT **before** the cookie — so the receiver never needs to know which app is calling, only which user and which scopes.

## When to use this skill

- A CLI or AI agent must create / update things as the user (mazuoboeru: AI-driven quiz mass-production through `mzo`)
- App-to-app push on the user's behalf where the receiver must stay ignorant of the sender ("my quiz app posts today's results into my diary app")
- Symptoms in an existing app:
  - every non-GET call from the CLI returns `403 csrf_origin_mismatch` → the CSRF Origin check is not exempting Bearer
  - a token can call `POST /api/tokens` and mint more tokens → management route is behind `requireAuth` instead of `requireSession`
  - revoking a token logs the user out (or vice versa) → sessions and PATs share a table
  - a D1 dump would hand out live credentials → raw tokens stored
  - one busy agent writes `last_used_at` on every request → no throttle

Do **not** use for:
- Third-party developer apps that need a consent screen, refresh tokens or per-app client ids — that is being an OAuth *provider*, a different design
- Worker-to-Worker calls inside **one** Cloudflare account — use a service binding, no secret at all
- Anonymous API keys with no user behind them (metrics, public read APIs) — no `user_id`, no scopes; a different table
- **Cloudflare API tokens** (`wrangler deploy`, CI) — unrelated despite the name; see `cloudflare-api-token-permissions`

## Decision: why a PAT (and when not)

| Option | Per-user machine access | Why it lost / won (source) |
|---|---|---|
| **PAT (Bearer)** | ✓ | ~150 LOC, one table, works from `curl`; the user copies one secret by hand (ADR-0001) |
| OAuth Device Authorization Grant | later | nicer CLI login, but +200 LOC and a polling endpoint; can be layered on top of PATs (ADR-0001) |
| Cloudflare Access service token | ✗ | a machine identity, not a user; authz lives in the dashboard |
| Service binding | ✗ | only within one account — a self-hosted receiver in *another* account can't be bound |
| HMAC-signed webhook | ✗ | the same shared secret minus the user, scopes, revocation list and UI; pick it only when the receiver has no users / sessions at all |

Constraints you accept: the raw token crosses a boundary by hand (so scope it minimally and make revocation one click), and a pepper rotation invalidates **every** token.

## Deliverables (completion criteria)

- [ ] `api_token(id, user_id → users CASCADE, name, token_hash UNIQUE, scopes JSON, created_at, last_used_at, expires_at, revoked_at)` + `INDEX (user_id, revoked_at)` ([references/schema-and-crypto.md](references/schema-and-crypto.md))
- [ ] `PAT_PEPPER` set with `wrangler secret put` in prod, in `.dev.vars` locally, listed (key only) in `.dev.vars.example`
- [ ] Token = `<app>_pat_` + base64url(32 random bytes); the raw value is returned **once**, from `POST /api/tokens` (201), never again
- [ ] `validatePat` rejects in this order: no `Bearer ` → wrong prefix → hash miss → `revoked_at` → `expires_at`; one indexed lookup joined with `user`; `last_used_at` written at most hourly
- [ ] `authenticate()` tries the PAT **before** the session and records `c.var.authMethod` as `"pat" | "session"`
- [ ] `/api/tokens/*` sits behind `requireSession` → a PAT gets `403 session_required`
- [ ] PAT-reachable mutations stack `requireAuth, requireScope("<resource>:write")` — in that order; sessions pass every scope
- [ ] `SCOPES` is a `const` tuple; stored scopes unknown to the current build are dropped on parse
- [ ] The CSRF Origin check skips requests that carry `Authorization: Bearer`
- [ ] No `console.*` of the `Authorization` header or a token anywhere (Workers Observability persists it); log the token `id`
- [ ] Settings UI: name → create → show-once card → list (name / created / last used / state) → revoke
- [ ] Caller docs name the env var (`<APP>_PAT`), the base-URL override and a `whoami` smoke command
- [ ] Every `UNVERIFIED:` bullet below checked on the real app and written back

## Architecture in one screen

```
caller: CLI env var / another Worker's secret / agent sandbox env
  └─ Authorization: Bearer <app>_pat_…  ──▶ Worker (Hono)
                                              ├─ securityHeaders
                                              ├─ csrf             non-GET: Origin === ORIGIN — SKIPPED for Bearer
                                              ├─ optionalAuth     PAT first → cookie session → c.var.{user,authMethod,scopes}
                                              ├─ /api/tokens/*    requireSession   (cookie only: a PAT can't mint PATs)
                                              └─ domain routes    requireAuth [, requireScope("x:write")]
                                              D1: api_token(token_hash UNIQUE) ⋈ user
```

| Layer | Owns | Must not do |
|---|---|---|
| token string | entropy (32 random bytes) + a greppable prefix | carry claims (it's opaque, not a JWT) |
| `token_hash` + `PAT_PEPPER` | "a DB leak is not a credential leak" | be reversible; the pepper never sits in the DB or the repo |
| `validatePat` | token → `{ user, scopes }` or `null`, cheap rejects first | set context vars, decide per-route access |
| `authenticate` / `optionalAuth` / `requireAuth` | which credential wins, `authMethod` | scope decisions |
| `requireScope` | the PAT scope gate (sessions pass) | authenticate — it assumes `requireAuth` ran |
| `/api/tokens` router | mint / list / revoke, session-only | return a hash, or a raw token twice |

## Token format and storage

- **Format**: `<app>_pat_` + `base64url(crypto.getRandomValues(32 bytes))` — e.g. `mzo_pat_…`. 256 bits of entropy; no structure, no claims.
- **The prefix is for identification, not protection.** It makes tokens greppable in logs, dumps and paste-bins, lets `validatePat` reject junk before touching D1, and lets *you* write a scanner rule (gitleaks, or a GitHub **custom pattern** — which needs GitHub Secret Protection on an org-owned repo on Team / Enterprise Cloud). GitHub's free push protection on a personal or public repo knows only GitHub's built-in supported patterns, so `<app>_pat_` is **not** auto-detected there (verified against docs.github.com 2026-08-22; mazuoboeru's source comment and `docs/data-model.md` are more optimistic than that).
- **Storage**: `token_hash = sha256(token + PAT_PEPPER)`, hex, `UNIQUE`. A 256-bit random token already makes an unsalted sha256 unguessable; the pepper (a Worker Secret) is cheap belt-and-braces **and** the single switch that kills every token at once — that is its real cost, see Ops. Plain sha256 is correct here: these are random tokens, not passwords, so a slow hash would only burn CPU per request (WebCrypto has no argon2 anyway).
- **Returned**: the raw token exactly once, in the `201` of `POST /api/tokens`; list responses carry `id`, `name`, `scopes` and timestamps and never the hash.
- **Expiry**: `expires_at` is optional; mazuoboeru defaults to **no expiry** because the audience is long-running agents and revocation is one click. A human-facing CLI may prefer 90 days — decide per app and say so in the UI.
- **Scopes**: a JSON array in a TEXT column, e.g. `["quiz:read","quiz:write"]`; MVP grants the full set (no picker) and still checks it on the way in.

## Validation order — cheap rejects before D1

```ts
if (!authorization?.startsWith("Bearer ")) return null;   // not a PAT request
const token = authorization.slice("Bearer ".length).trim();
if (!token.startsWith(PAT_PREFIX)) return null;            // junk / other schemes: no hash, no D1
const tokenHash = await sha256Hex(token + (env.PAT_PEPPER ?? ""));
// ONE indexed point read, joined with user
// → null if no row; null if revoked_at !== null; null if expires_at < now
// → write last_used_at only if older than 1 h
return { user, scopes: parseScopes(row.scopes) };
```

The prefix gate matters for the bot-scan budget: a scanner spraying `Authorization: Bearer xyz` at your API costs you a string compare, not a D1 query (`cloudflare-workers-bot-scan-defense`). The hourly `last_used_at` throttle keeps an agent doing 1,000 calls from doing 1,000 D1 writes. Full `validatePat` in [references/pat-and-middleware.md](references/pat-and-middleware.md).

## Middleware: PAT before session, and the three guards

`authenticate(c)` = `validatePat(...)` ?? `getSessionUser(c)` ?? `null`, then `c.set("user" | "authMethod" | "scopes")`. Built on it:

| Guard | Passes when | Use on |
|---|---|---|
| `optionalAuth` | always (sets vars if authenticated) | the whole `/api` group, so public routes can personalise |
| `requireAuth` | session **or** PAT | anything the user owns |
| `requireSession` | cookie session only (`403 session_required` for a PAT) | `/api/tokens/*`, account deletion, anything that changes *credentials* |
| `requireScope(s)` | `authMethod !== "pat"`, or `scopes` includes `s` | PAT-reachable mutations, **stacked after `requireAuth`** |

**Why the PAT wins over a cookie that rides along**: an explicit credential should be judged by *its* scopes; that is also what lets you test a scoped token from a logged-in browser.

**Why sessions are `scopes: []`** meaning "not scope-limited": the session is the human; limiting it would only add a second permission model. Scopes exist to make a leaked or over-shared PAT less valuable.

**Composing with a passkey session** (kokemusu): mazuoboeru's session layer exposes `getSessionUser(c)` returning the `user` row; `cloudflare-workers-passkey-auth` instead sets `userId` / `displayName` inside its own `sessionMiddleware`. Either way, factor the cookie lookup into a function the PAT path can fall back to, and have both paths set the **same** context variables — the variant is sketched in the reference (UNVERIFIED).

## CSRF: exempt Bearer, keep the Origin check for cookies

```ts
if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
  const isBearer = c.req.header("Authorization")?.startsWith("Bearer ") ?? false;
  if (!isBearer && c.req.header("Origin") !== c.env.ORIGIN) return c.json(apiError("csrf_origin_mismatch"), 403);
}
```

A cross-site page can make the browser attach the victim's **cookie**, never the victim's `Authorization` header — so a Bearer request has no ambient credential to forge, and the Origin requirement (which a CLI or another Worker can't satisfy) adds nothing. The wrong fix, when the CLI starts getting 403s, is to relax the Origin check globally; that reopens CSRF for every cookie route.

## Management routes and the settings UI

| Route | Auth | Notes |
|---|---|---|
| `GET /api/tokens` | session | `{ tokens: [{ id, name, scopes, createdAt, lastUsedAt, expiresAt, revokedAt }] }` — no hash |
| `POST /api/tokens` `{ name }` | session | `201 { token: { id, name, token, scopes, createdAt } }` — `token` appears here and nowhere else |
| `DELETE /api/tokens/:id` | session | sets `revoked_at` (row kept for audit / `last_used_at`); `404 not_found` when it isn't yours — never 403 |

The UI is a name field, a **show-once card** (`<code>` + "shown only now"), and a table with name / created / last used / state / revoke. Keep revoked rows visible as "失効済み" so a user can see *when* a token died. Full router, `index.ts` mount, React view and the typed `hc` client in [references/routes-and-client.md](references/routes-and-client.md).

## The caller side: where the token lives

| Caller | Keep the token in | Notes |
|---|---|---|
| CLI | env var `<APP>_PAT` (+ `<APP>_BASE_URL` to aim at dev) | never argv (visible in `ps`), never a committed file; `whoami` is the smoke test (mazuoboeru `mzo`) |
| Another Worker, **your** account only | `wrangler secret put <RECEIVER>_PAT` + the URL as a `vars` entry | the personal-use shape of "quiz app → diary app": a Cron builds the day's post and `fetch`es with Bearer |
| Another app, **per user** | its own DB, **encrypted** (AES-GCM under a Worker Secret), not hashed — it has to send it | plus a delivery ledger for idempotency; a separate skill (`cloudflare-workers-outbound-integration`, planned) |
| AI agent in a sandbox | the sandbox's env | the token crosses the isolation boundary on purpose — grant the narrowest scope and revoke when the job is done |

Receiver-side contract for app-to-app pushes: one route (`POST /api/posts`), one write scope (`post:write`), a body with no sender-specific fields, and — if the caller retries on failure — an `Idempotency-Key` header the receiver remembers for 24 h (design note; not in the source project).

## Rate limiting and logging hygiene

- PAT-bearing routes are reachable without a session, so they belong in the bot-scan table: the prefix check makes junk free and the hash lookup is one indexed read, but a brute force against `/api/<thing>` with well-formed `…_pat_` strings still costs a D1 read each. Add a **second** `ratelimits` entry (e.g. `API_RATE_LIMITER`, its own `namespace_id`, limit above your busiest agent's burst) with the same fail-open `CF-Connecting-IP` middleware shape as `cloudflare-workers-bot-scan-defense` — don't reuse its login limiter (30 / 60 s), or one busy agent locks the user out of login (UNVERIFIED — mazuoboeru has not wired it; its pending item is a per-user write limit).
- **Never log the header.** `observability.head_sampling_rate: 1` persists every `console.log`; log `token.id` and `user.id`. Tokens travel only in the `Authorization` header — a `?token=` query string lands in logs and `Referer`.

## Ops

- **Pepper**: `openssl rand -hex 32 | wrangler secret put PAT_PEPPER`; local `.dev.vars` gets its own value. **Set it before the first token is minted** — `validatePat` hashes with `PAT_PEPPER ?? ""`, so tokens minted while it was unset die the moment it is set. **Rotating it invalidates every PAT** — announce, rotate, tell users to re-mint. There is no gradual rotation without a `pepper_version` per row (not built).
- **Leak**: the token *is* the credential — revoke it (`DELETE /api/tokens/:id`, or `UPDATE api_token SET revoked_at = … WHERE id = …`); nothing else to rotate. `last_used_at` (hourly granularity) tells you whether it was used after the leak.
- **User deletion** cascades `api_token`. If your users table has a suspension flag, check it in `validatePat` so a PAT dies with the account — mazuoboeru has `user.status` but no auth path reads it yet.
- Incident queries (hash never selected) and the rest in [references/ops-and-testing.md](references/ops-and-testing.md).

## Tests and e2e

State of the source project: the CLI's request builders are pure and table-tested (`Authorization: Bearer …` asserted on a fake token); `validatePat` itself has no unit test (it needs D1); there is **no** PAT e2e spec — the 3-spec scope of `cloudflare-workers-e2e-playwright` covers the session paths, and the PAT smoke before a release is `mzo whoami` by hand. If you add one API-level spec, make it: seeded session → `POST /api/tokens` → Bearer call → 200; same token → `POST /api/tokens` → `403 session_required`; revoke → `401`. Sketch in the ops reference (UNVERIFIED).

## The pitfalls that eat hours

- **`403 csrf_origin_mismatch` on every CLI mutation** → the Origin check must skip Bearer requests (and only them).
- **A PAT can mint PATs** → `/api/tokens` behind `requireAuth` instead of `requireSession`; an exfiltrated token then becomes permanent.
- **`requireScope` without `requireAuth` in front** → `authMethod` is undefined, the scope check passes, and the handler either 500s on `requireUser` or — worse — runs. It is a scope gate, not an auth gate.
- **`last_used_at` on every request** → one D1 write per API call. Throttle (hourly).
- **Logging the `Authorization` header** (a debug line that survives) → tokens sit in Workers Logs for the whole retention window (3 days Free / 7 days Paid, longer if you export them), readable by anyone with dashboard access.
- **Token in the query string** → logs and `Referer`.
- **Renaming a scope without migrating stored JSON** → unknown scopes are dropped on parse and every existing token silently loses the permission (403). Treat scope renames as data migrations.
- **Trusting the prefix as secret-scanning protection** on a personal / public repo → it isn't; add a gitleaks rule, or a GitHub custom pattern where you have Secret Protection.
- **403 on someone else's token id** → existence leak; revoke answers `404` for anything not yours.
- **Hashing without the `Bearer ` / prefix gates** → every scanner request costs a sha256 + D1 read.
- **`startsWith("Bearer ")` is case-sensitive** while RFC 9110 makes the scheme case-insensitive — fine for your own CLI, but note it if a third-party client sends `bearer`.

## Unverified claims — confirm while implementing, then write back

- UNVERIFIED: the passkey-session composition (`authenticate` falling back to `cloudflare-workers-passkey-auth`'s cookie lookup, both paths setting `userId` / `displayName`) has not run — kokemusu is the first; record the final `Variables` shape in the middleware reference.
- UNVERIFIED: per-IP rate limiting of PAT-reachable mutation routes via the bot-scan binding — not wired in mazuoboeru; confirm it does not throttle a legitimately busy agent behind one IP (limit ≥ the agent's burst).
- UNVERIFIED: the API-level PAT e2e spec (mint → call → `session_required` → revoke → 401) — sketched, not run.
- UNVERIFIED: Hono RPC (`hc<AppType>`) inference across a router that starts with `.use("*", requireSession)` — works in mazuoboeru on Hono `^4.6`; re-check after a Hono major bump.
- UNVERIFIED: the receiver-side `Idempotency-Key` contract for retrying callers — design note only; belongs to the outbound-integration skill once built.

## Scope boundary — what this skill does NOT cover

- The cookie session itself — OAuth (`arctic`, mazuoboeru) or passkeys (`cloudflare-workers-passkey-auth`); this skill only plugs in front of it
- The **sender** side of a per-user integration (storing other people's tokens encrypted, delivery ledger, retries) — planned `cloudflare-workers-outbound-integration`
- Rate-limit binding config, WAF rules, observability setup — `cloudflare-workers-bot-scan-defense`
- OAuth device flow for CLI login, being an OAuth provider, refresh tokens
- **Cloudflare API tokens** for `wrangler` / CI — `cloudflare-api-token-permissions`
- Playwright wiring and the seeded-session seam — `cloudflare-workers-e2e-playwright`

## References

- [references/schema-and-crypto.md](references/schema-and-crypto.md) — Drizzle `api_token` + generated SQL, index rationale, `crypto.ts` (`randomToken`, `sha256Hex`), `json.ts`, `.dev.vars.example`, `wrangler secret put`
- [references/pat-and-middleware.md](references/pat-and-middleware.md) — `auth/scopes.ts`, `auth/pat.ts`, `auth/middleware.ts`, `types.ts` / `errors.ts` additions, the passkey-session variant
- [references/routes-and-client.md](references/routes-and-client.md) — `routes/tokens.ts`, `index.ts` mount order, the CSRF middleware, the React settings view + typed client, CLI request builders, `curl` smoke, the receiver-side push endpoint sketch
- [references/ops-and-testing.md](references/ops-and-testing.md) — pepper setup / rotation, leak runbook, incident SQL, rate-limit wiring, logging rules, existing tests and the proposed e2e spec
