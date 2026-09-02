---
name: cloudflare-workers-passkey-auth
description: Add passkey-only (WebAuthn) closed registration + revocable sessions to a Cloudflare Workers app (Hono + D1 + Drizzle) for a family-scale app — @simplewebauthn v13, a signed 5-minute challenge cookie (no D1 challenge table), an HS256 session JWT backed by a sessions table (revocable, 30-day sliding), and a public register endpoint dispatching initial-token vs space-invite registration. Use when building login for an invite-only app without passwords or OAuth, when "every iPhone user gets 401" on login (counter-regression check without the counter=0 exemption for synced passkeys), when all passkeys died after a domain/subdomain change (RP_ID lock), when startRegistration throws NotAllowedError / InvalidStateError / SecurityError, or when the session cookie must not leak to sibling *.workers.dev Workers (host-only, __Host- prefix). Covers schema, routes, dev-bypass twin guard, CSRF Origin check, auth rate limits, INITIAL_REGISTRATION_TOKEN cycle, SESSION_SECRET rotation, lost-passkey recovery.
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets Cloudflare Workers with Hono 4 + Drizzle ORM on D1, @simplewebauthn/server + @simplewebauthn/browser ^13 (WebCrypto, no nodejs_compat), hono/jwt + hono/cookie, a React SPA served by the same Worker via @cloudflare/vite-plugin, wrangler 4, pnpm. Assumes the cloudflare-workers-deploy-skeleton baseline. Users need modern browsers with platform authenticators (iOS / Android / desktop passkeys).
metadata:
  author: okayus
  version: "0.2.1"
---

# Cloudflare Workers Passkey Auth (closed registration, revocable sessions)

Get a Hono + D1 Worker to the state where **the only way in is a passkey, registration is closed except through a one-shot bootstrap token (or a space invite), and any session can be killed server-side** — with zero password, zero external IdP, and zero D1 table for WebAuthn challenges.

Extracted from nyalog (ADR-003, PR-level code) and routine-tasks (Phase 4a/4b walkthrough), 2026-08-22. Cookie/CSRF details from mazuoboeru.

**Why this shape**: a private app used by a handful of known people (a family) doesn't need sign-up, password reset, or a login screen with an email field. What it needs is phishing resistance (RP-ID-bound passkeys), instant revocation (a `sessions` row, not a bare JWT), and a registration door that is shut by default. Every piece here exists because the naive version (JWT-only sessions, `secure: true` hardcoded, a strict signature-counter check, a `Domain=` cookie) broke in production in one of the source projects.

## When to use this skill

- Building login for an invite-only app (family, household, 2–10 people) on the `cloudflare-workers-deploy-skeleton` stack, and you've decided against OAuth / Cloudflare Access (decision table below)
- Symptoms you are hitting:
  - every iPhone / iCloud-Keychain user gets `401` on login while Android/desktop works → signature-counter check without the `counter === 0` exemption
  - all registered passkeys stopped working after a hostname change (account-subdomain rename, custom domain) → RP_ID lock broken
  - `startRegistration` / `startAuthentication` throws `NotAllowedError`, `InvalidStateError`, or `SecurityError` → see the client-flow reference
  - a session cookie shows up on a *different* Worker under the same `*.workers.dev` subdomain → `Domain=` attribute / not host-only
  - the login endpoint returns `401` even though it should be public → protected sub-app mounted before the public auth routes
- Adding "add this device as a passkey" / "revoke that device" management to an existing passkey app

Do **not** use for:
- A public SaaS with self-service sign-up — use OAuth (mazuoboeru's `arctic` setup) and the seeded-session e2e seam in `cloudflare-workers-e2e-playwright`; passkeys there are a Phase-2 add-on, not the front door
- Apps that must stay behind Cloudflare Access (allowlist-by-dashboard) — different threat model, nothing here applies
- Password or magic-link auth — none of the challenge/counter/RP_ID machinery transfers

## Decision: why passkeys here (and when not)

| Option | Family-scale private app | Why it lost / won (source) |
|---|---|---|
| Cloudflare Access (Google IdP) | ✗ | OTP/SSO round-trip on every mobile open; authz lives in the dashboard, no in-app logout/device management (nyalog ADR-002 → ADR-003) |
| Google OAuth | ✗ | Per-project Google Cloud console work (OAuth client + consent screen) that doesn't scale across hobby projects (mazuoboeru ADR-0001 addendum) |
| GitHub OAuth | ✗ | Family members don't have GitHub accounts — developer-only audience |
| **Passkeys (WebAuthn)** | ✓ | Login = unlock gesture; RP-ID binding = phishing resistance; no shared secret server-side; closed registration is natural |
| Auth SaaS / Better Auth / Lucia | ✗ | Lucia deprecated 2025-03; the rest are oversized for ~4 users and add classes/lock-in |

Constraints you accept with passkeys: **RP_ID is permanent** (see below), each person should register **two** authenticators (no password reset exists), and a lost-everything recovery needs an operator (runbook in `references/ops-and-recovery.md`).

## Deliverables (completion criteria)

- [ ] `users` / `credentials` / `sessions` tables migrated (Drizzle + SQL in `references/schema.md`)
- [ ] `POST /api/auth/register/begin|verify` is **public** and dispatches `initial` (one-shot secret) vs `invite` (space token) inside the handler; returns `403 registration_closed` when `INITIAL_REGISTRATION_TOKEN` is unset
- [ ] `POST /api/auth/credentials/add/begin|verify` (add a device) sits **behind** `sessionMiddleware()` and uses `excludeCredentials`
- [ ] `POST /api/auth/login/begin|verify` is username-less (`residentKey: "required"`, no `allowCredentials`); verify passes `requireUserVerification: false`
- [ ] WebAuthn challenge lives in a **signed 5-minute cookie** (`hono/jwt` over `SESSION_SECRET`) carrying the registration state; no `challenges` table
- [ ] Session = HS256 JWT with `sid` + a `sessions` row; logout deletes the row; expiry slides (30 days)
- [ ] Cookies are host-only (no `Domain`), `HttpOnly`, `SameSite=Lax`, `Path=/`; `secure` and the `__Host-` prefix are **derived from the `ORIGIN` scheme**, never hardcoded
- [ ] Non-GET `/api/*` requests require `Origin === ORIGIN` (`403 csrf_origin_mismatch`)
- [ ] The 4 unauthenticated auth routes are IP-rate-limited (`CF-Connecting-IP`), config per `cloudflare-workers-bot-scan-defense`
- [ ] `DEV_BYPASS_USER_ID` is honored only when `ORIGIN` is a localhost origin; `wrangler secret list` on prod never shows it
- [ ] `RP_ID` / `ORIGIN` are pinned in `wrangler.jsonc` `vars` to the final production hostname **before** the first passkey is registered; `.dev.vars` overrides them locally
- [ ] `DELETE /api/auth/credentials/:id` refuses to delete the user's last credential (`400 last_credential`)
- [ ] `.dev.vars.example` lists `SESSION_SECRET`, `RP_ID`, `ORIGIN`, `INITIAL_REGISTRATION_TOKEN`, `DEV_BYPASS_USER_ID` (keys only)
- [ ] Every `UNVERIFIED:` bullet below has been checked on the real app and the result written back into this skill

## Architecture in one screen

```
Browser ──HTTPS + cookies──▶ Worker (Hono)
                              ├─ secureHeaders                 (CSP/HSTS — deploy-skeleton)
                              ├─ csrfOriginCheck on /api/*     (non-GET: Origin === ORIGIN)
                              ├─ /api/auth/{register,login}/*  PUBLIC + authRateLimit
                              ├─ sessionMiddleware             (JWT → sessions row → c.var.userId)
                              └─ everything else under /api    (domain routes)
                              D1: users · credentials (public keys) · sessions (revocation)
                              @simplewebauthn/server: verify{Registration,Authentication}Response
```

| Layer | Owns | Must not do |
|---|---|---|
| WebAuthn ceremony | "is the holder of this authenticator real" | sessions, authorization |
| Challenge cookie | one-shot state between `begin` and `verify` (signed, 5 min) | outlive the ceremony |
| Session JWT | carry `sid` to the server with a signature | carry permissions |
| `sessions` table | truth about "is this sid alive" | duplicate JWT claims |
| `sessionMiddleware` | authenticate + load `c.var.userId` (+ space memberships, sibling skill) | decide per-resource access |

## Schema — three tables

`users(id, display_name, created_at)`, `credentials(id = WebAuthn credential id base64url, user_id, public_key, counter, transports JSON, device_name, backed_up, created_at, last_used_at)`, `sessions(id = sid, user_id, expires_at, created_at)`. `public_key` is stored as **base64url TEXT** (nyalog), not BLOB (routine-tasks): readable in SQL dumps/`wrangler d1 execute` output, no Drizzle blob-mode typing questions; the 4/3 size inflation on a ~80-byte key is irrelevant. Both child tables cascade on user delete. Full Drizzle + SQL and the migration-order note in [references/schema.md](references/schema.md).

Design `NOT NULL` columns from day one — `users` is a parent with `ON DELETE CASCADE` children, and a later table-rebuild migration on it is exactly the D1 cascade-delete trap in `cloudflare-d1-drizzle-migration`.

## Challenge cookie and session cookie

- **Challenge**: `generate*Options()` → put `{ challenge, state, aud: "app:challenge", exp: now+300s }` into a signed cookie → `verify` reads **and deletes** the cookie before validating it (single use). `state` is a discriminated union: `authentication` | `add-credential{uid}` | `initial{uid, displayName}` | `invite{uid, displayName, inviteId, spaceId}`. Because the state is signed server-side, `verify` never trusts client-supplied ids. (routine-tasks round-trips `registration: {kind, pendingUserId, inviteId, spaceId}` through the client body *unsigned*; an invite holder could then pick `spaceId` — keep it in the cookie.)
- **Session**: `issueSession` inserts a `sessions` row (`sid = crypto.randomUUID()`, `expires_at = now+30d`) and sets the JWT `{ sid, aud: "app:session", exp }`. `sessionMiddleware` verifies the JWT, loads `sessions ⋈ users` by `sid`, rejects missing/expired rows (`401 session_expired`, cookie cleared), sets `c.var.userId` / `c.var.displayName`, and **slides** the expiry when less than half remains (one DB write per ~15 days per session; mazuoboeru's alternative is "refresh at most once a day").
- **Cookie attributes** (both cookies): `HttpOnly`, `SameSite=Lax`, `Path=/`, **no `Domain`** — sibling Workers share `<account>.workers.dev`, so a `Domain=` cookie is readable/tossable across your other apps. Name is `__Host-session` when `ORIGIN` starts with `https://` (browser-enforced Secure + Path=/ + no Domain), plain `session` otherwise; `secure` is `ORIGIN.startsWith("https://")`. Hardcoding `secure: true` (nyalog) makes the cookie silently vanish on `http://127.0.0.1` e2e runs. **Deleting uses the same attribute set** (`deleteCookie(c, name, cookieBase(c))`): Hono throws on a `__Host-` name without `secure`, and a browser ignores a non-Secure `__Host-` Set-Cookie, so `{ path: "/" }` alone leaves the session cookie alive on https (verified 2026-08-30 in matatabetai).
- One `SESSION_SECRET` signs both JWTs; the distinct `aud` values stop a session token from being replayed as a challenge and vice versa.

Templates: [references/session-and-challenge.md](references/session-and-challenge.md).

## Routes and the public register dispatch

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/auth/register/begin` | public + rate limit | Dispatch: body has `inviteToken` → validate invite (sibling skill) ; else `initialRegistrationToken` must equal the `INITIAL_REGISTRATION_TOKEN` secret, else `403 registration_closed`. Issue challenge with `{kind, uid: fresh UUID, displayName, …}` |
| `POST /api/auth/register/verify` | public + rate limit | Consume challenge, `verifyRegistrationResponse`, then ONE `db.batch`: `users` + `credentials` (+ `spaces`/`space_members`/`invites` UPDATE per the sibling skill) → `issueSession` |
| `POST /api/auth/login/begin` | public + rate limit | `generateAuthenticationOptions({ rpID, userVerification: "preferred" })` — no `allowCredentials` → browser shows the passkey picker |
| `POST /api/auth/login/verify` | public + rate limit | Look up `credentials` by `response.id`, `verifyAuthenticationResponse`, store `newCounter` + `last_used_at`, `issueSession` |
| `POST /api/auth/logout` | session | delete the `sessions` row, clear cookie |
| `GET /api/auth/me` | session | `{ id, displayName }` (+ memberships, sibling skill) |
| `GET /api/auth/credentials` | session | list devices (`deviceName`, `backedUp`, `lastUsedAt`) |
| `POST /api/auth/credentials/add/begin|verify` | session | add a device; `excludeCredentials` = user's existing ids; challenge state `{ kind: "add-credential", uid }` must match `c.var.userId` |
| `DELETE /api/auth/credentials/:id` | session | scoped to `user_id`; `400 last_credential` when it's the only one |

**Why `register/*` is public and dispatches inside the handler**: the caller is, by definition, not logged in (initial owner or invited newcomer). routine-tasks also folded the "add a device" path into the same public endpoint by re-verifying the session cookie inline; mounting `credentials/add/*` behind `sessionMiddleware()` (nyalog) is the same thing with less duplicated verification code — do that.

**Mount order trap** (Hono): register the public `/auth` routes on the `api` app **before** `api.route("/", protectedApi)`; `protectedApi.use("/*", sessionMiddleware())` matches every `/api/*` path, and a later-registered handler only wins because the earlier public handler returned first. Swap the two lines and `login/begin` answers `401`.

Full handlers, `csrfOriginCheck`, `authRateLimit`, and `worker/index.ts` in [references/auth-routes.md](references/auth-routes.md).

## Login: username-less + the counter-regression exemption

- `residentKey: "required"` at registration + no `allowCredentials` at login = one "Log in" button, no identifier field; the authenticator lists its passkeys for this RP_ID.
- `userVerification: "preferred"` + `requireUserVerification: false` on verify: biometrics when available, no hard failure on authenticators without UV UX.
- **Signature counter**: store `authenticationInfo.newCounter` after every login. If you write your own regression guard, it must be `if (stored !== 0 && newCounter <= stored) reject` — synced passkeys (iCloud Keychain, Google Password Manager) report `0` forever, and a strict `<=` check locked out every iPhone in the family in routine-tasks. `@simplewebauthn/server` already applies the same "only when either counter > 0" rule inside `verifyAuthenticationResponse` (see UNVERIFIED), so the explicit guard is belt-and-braces.
- Store `credentialBackedUp` (`backed_up`) and show it in the device list — it tells the user which passkeys survive a lost phone.

## RP_ID: locked on the first registration

`RP_ID` (hostname, no scheme/port) and `ORIGIN` (scheme + host [+ port]) are **credential-binding inputs**. Changing `RP_ID` invalidates every registered passkey; `expectedOrigin` mismatch fails every ceremony.

- Pin both in `wrangler.jsonc` `vars` to the **final** production hostname before anyone registers. If a custom domain is ever planned, move there *first* (mazuoboeru ADR-0001 addendum), then register.
- Two real incidents: nyalog renamed its Cloudflare account subdomain (`<old>` → `<new>.workers.dev`) and every family member re-registered; routine-tasks ADR-0002 now treats any diff to `RP_ID`/`ORIGIN` in a PR as an automatic reject.
- Local: `.dev.vars` overrides `RP_ID=localhost` / `ORIGIN=http://localhost:5173` (gitignored, cannot leak to prod). `cloudflare-workers-deploy-skeleton` states the rule; this skill owns the consequences and the forced-change procedure in `references/ops-and-recovery.md`.

## Dev bypass: the twin guard

`sessionMiddleware` short-circuits to a fixed user **only if** `DEV_BYPASS_USER_ID` is set **and** `new URL(ORIGIN).hostname` is `localhost` / `127.0.0.1`. It auto-creates that user row (and, with spaces, a fixed dev space membership — sibling skill) so local D1 is never empty. If the variable is set on a non-local origin it logs `console.error` and falls through to real verification. Never `wrangler secret put DEV_BYPASS_USER_ID`; `wrangler secret list` on prod must never show it. e2e golden paths must **not** rely on it (`cloudflare-workers-e2e-playwright` uses the CDP virtual authenticator).

## Rate limit and CSRF

The only unauthenticated routes that do work are `register/begin|verify` and `login/begin|verify`. Key a ratelimits binding on `CF-Connecting-IP` and return `429 rate_limited`; the `wrangler.jsonc` block, the binding-vs-WAF decision and the "synthetic bursts never hit 429" eventual-consistency caveat live in `cloudflare-workers-bot-scan-defense`. In the credential-free sandbox the binding is stripped from the e2e config (`playwright-e2e-in-docker-sandbox`).

CSRF: `SameSite=Lax` already blocks cross-site POSTs from top-level navigations; add `csrfOriginCheck` on `/api/*` — non-GET requests must carry `Origin` equal to `ORIGIN` (`403 csrf_origin_mismatch`). GETs are exempt, which is also what lets e2e API specs send a bare `Cookie` header.

## Ops: tokens, secrets, recovery

- **Bootstrap**: `openssl rand -hex 32 | wrangler secret put INITIAL_REGISTRATION_TOKEN` → hand the value over out-of-band → owner registers → `wrangler secret delete INITIAL_REGISTRATION_TOKEN` immediately. Unset secret = `403 registration_closed`, which also closes the deploy-then-race window.
- **`SESSION_SECRET` rotation** = every session and pending challenge becomes invalid (everyone logs in again); then `DELETE FROM sessions` to drop the orphans.
- **Lost every passkey**: the operator re-opens the initial token (creates a fresh owner user; family-shared data is still reachable because authorization is per space, not per user) or pre-builds the optional recovery path that attaches a new credential to an existing `user_id`. Data source for anything worse is the D1 backup / Time Travel (`cloudflare-d1-weekly-backup-via-pr`).

Runbooks in [references/ops-and-recovery.md](references/ops-and-recovery.md); the browser side (`@simplewebauthn/browser` v13 `optionsJSON` wrapper, error-code mapping, React hook) in [references/client-flow.md](references/client-flow.md).

## e2e

Do not duplicate the recipe: `cloudflare-workers-e2e-playwright` owns the CDP `WebAuthn.addVirtualAuthenticator` helper, `RP_ID=localhost` in e2e vars, the "no `DEV_BYPASS` in the golden path" rule, and the 3-spec scope. This skill's only requirement on it: `ORIGIN` in the e2e vars must equal Playwright's `baseURL` byte-for-byte (scheme, host, port) or every `verify` fails with `challenge_mismatch` (origin mismatch) while `begin` succeeds.

## The pitfalls that eat hours

- **Strict counter check** → every synced-passkey user (iPhone) gets `401`. Exempt `stored === 0`.
- **`RP_ID` drift** (subdomain rename, custom domain, staging host) → all passkeys dead. Pin before the first registration; reject diffs.
- **`expectedOrigin` ≠ browser origin** (port, scheme, `localhost` vs `127.0.0.1`) → `begin` works, `verify` always fails. Check `ORIGIN` first, not the ceremony code.
- **`secure: true` hardcoded** → cookies silently dropped over `http://` dev/e2e. Derive from `ORIGIN`.
- **`Domain=` cookie** → readable by every Worker under your `*.workers.dev` subdomain. Host-only + `__Host-`.
- **Protected sub-app mounted before the public auth routes** → `login/begin` returns `401`.
- **Unsigned registration state round-tripped via the client** → invite holder chooses the space. Sign it into the challenge cookie.
- **`TextEncoder.encode()` typed `Uint8Array<ArrayBufferLike>`** (TS ≥ 5.7) rejected by `@simplewebauthn`'s `Uint8Array<ArrayBuffer>` params → copy into a fresh `ArrayBuffer` (helper in the routes reference).
- **JWT-only sessions** → logout/device-loss cannot revoke. Keep the `sessions` row as the source of truth.
- **Forgetting `wrangler secret delete INITIAL_REGISTRATION_TOKEN`** → the registration door stays open with a token sitting in someone's chat history.
- **Single passkey per person** → a lost phone is an operator recovery. Make "add a second device" part of onboarding.

## Unverified claims — confirm while implementing, then write back

Record each result in the section named; delete the bullet once it's confirmed or corrected.

- UNVERIFIED: current Safari/iOS still require `navigator.credentials.create()` to be called from a user gesture (older Safari did). The client reference always calls from a click handler; confirm whether auto-triggered login works → "client-flow" reference.
- UNVERIFIED: passing `allowCredentials: []` vs omitting it to `generateAuthenticationOptions` behaves identically in all target browsers. By spec both mean "discoverable credentials" (`allowCredentials` defaults to `[]` when absent; `@simplewebauthn/server@13.3.3` omits the key when the option is undefined), and Chromium's virtual authenticator accepts the omitted form (verified 2026-08-30 in matatabetai e2e) — real iOS / Android not yet exercised → "Login" section.

### Verified 2026-08-30 in matatabetai (first production user of this skill)

- `@simplewebauthn/server@13.3.3` `verifyAuthenticationResponse` throws `Response counter value N was lower than expected M` only when `(counter > 0 || credential.counter > 0) && counter <= credential.counter` (`esm/authentication/verifyAuthenticationResponse.js`). The explicit `stored !== 0 && new <= stored` guard is therefore redundant; matatabetai keeps the rule as a pure function `isCounterRegression` with a unit test instead of duplicating it in the route.
- `@simplewebauthn/browser@13.3.0` `WebAuthnErrorCode` = `ERROR_CEREMONY_ABORTED | ERROR_INVALID_DOMAIN | ERROR_INVALID_RP_ID | ERROR_INVALID_USER_ID_LENGTH | ERROR_MALFORMED_PUBKEYCREDPARAMS | ERROR_AUTHENTICATOR_GENERAL_ERROR | ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT | ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT | ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED | ERROR_AUTHENTICATOR_NO_SUPPORTED_PUBKEYCREDPARAMS_ALG | ERROR_AUTO_REGISTER_USER_VERIFICATION_FAILURE | ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY` — every code used in `references/client-flow.md` exists.
- `hono/jwt` `verify()` (hono 4.13) rejects `exp <= now` by itself (`JwtTokenExpired`), validates `nbf` / `iat` when present, and accepts `{ alg, aud }` as the third argument — the challenge TTL can rely on it (unit test in matatabetai `worker/middleware/challenge-cookie.test.ts`).
- Raw `D1Database.batch()` on workerd returns per-statement `D1Result` with `meta.changes`; a 0-row `UPDATE … WHERE consumed_at IS NULL` yields `success: true, changes: 0` (the invite race check works as written). Drizzle's `db.batch()` was not needed — the registration batches use `c.env.DB` directly.
- WebAuthn at `http://127.0.0.1:<port>` is **not** needed: bind `wrangler dev --ip 127.0.0.1` (sandbox requirement) but open the page at `http://localhost:<port>` with `RP_ID=localhost` and `ORIGIN=http://localhost:<port>`; Chromium resolves `localhost` to the loopback and the CDP virtual authenticator registers / asserts fine. Written into `cloudflare-workers-e2e-playwright`.
- `Secure` / `__Host-` cookies over `http://127.0.0.1` were never exercised: the ORIGIN-scheme derivation means http origins get bare, non-Secure cookie names, so the question does not arise.
- **`deleteCookie` must carry the same attributes as `setCookie`.** Hono's cookie serializer throws `__Host- Cookie must have Secure attributes` for a `__Host-` name without `secure: true`, and browsers drop a `__Host-` Set-Cookie without `Secure` — so `deleteCookie(c, name, { path: "/" })` (the old template) breaks logout and challenge consumption on https. Pass `cookieBase(c)` (which includes `secure`) to `deleteCookie` too — the templates below and in `references/session-and-challenge.md` now do.
- `wrangler types` (wrangler 4.125) also emits the keys of a local `.dev.vars` into the generated `Env` as `string`. CI has no `.dev.vars`, so type the secrets yourself and intersect: `type Bindings = Env & { SESSION_SECRET: string; INITIAL_REGISTRATION_TOKEN?: string; DEV_BYPASS_USER_ID?: string }` — consistent in both environments.
- `@cloudflare/vite-plugin@1.53` copies `.dev.vars` into `dist/<worker>/.dev.vars` at build time, so `wrangler dev --config dist/<worker>/wrangler.json` picks up the dev `ORIGIN` — pass `--var ORIGIN:… --var RP_ID:… --var SESSION_SECRET:… --var INITIAL_REGISTRATION_TOKEN:…` for the e2e server to make the values explicit.
- Client side, `@simplewebauthn/browser` is optional: matatabetai calls the browser JSON API directly (`PublicKeyCredential.parseCreationOptionsFromJSON` / `parseRequestOptionsFromJSON` + `credential.toJSON()`, Baseline since 2025-03; `modern-web-guidance` recommends this over wrapper libraries) with the server's `PublicKeyCredentialCreationOptionsJSON` / `RegistrationResponseJSON` imported as **types** from `@simplewebauthn/server`. The DOMException mapping is the same (`NotAllowedError` / `InvalidStateError` / `SecurityError` / `NotSupportedError`), and the Signal API (`signalUnknownCredential` on login 404, `signalAllAcceptedCredentials` on the device list, `signalCurrentUserDetails` on rename) is feature-detected.

### Verified 2026-09-01 in kokemusu (single-user variant, second production user)

- **Single-user twist** (no spaces, no invites): `register/verify` adds a credential to the existing `user` row when one exists instead of minting a user — the same token-gated door then serves all-passkeys-lost recovery and a future `RP_ID` change without orphaning that user's rows. `register/begin` decides the `uid` (existing row's id, else a fresh UUID) and signs it into the challenge state, so a retried verify can never create a second user. Two devices registered in production, `INITIAL_REGISTRATION_TOKEN` deleted afterwards.
- **The `__Host-` deletion throw reached production unseen** (kokemusu #15): vite dev, unit tests and e2e all run on http, where cookie names are bare and hono's prefix check never fires; the first https verify was a 500. Keep **one unit test per cookie-clearing path with an https `ORIGIN`** (`app.request(...)` with `ORIGIN: "https://…"` reproduces the throw in Node) and route every deletion through a single `clearCookie(c, name)` that derives `secure` from `ORIGIN` — `deleteCookie` is then called in exactly one place.
- **`wrangler secret put` reads the value from stdin and prints nothing**, and secrets cannot be read back — `openssl rand -hex 32 | wrangler secret put INITIAL_REGISTRATION_TOKEN` stores a token nobody has ever seen (kokemusu 2026-09-01, had to mint again). Mint in two steps: print, then paste at the prompt. `references/ops-and-recovery.md` is corrected; a pipe stays fine for `SESSION_SECRET`, which no human needs to see.
- The wrangler 4 top-level `ratelimits` binding on `register|login/begin|verify` is **simulated locally** (40-burst → 429s after 30, credential-free container, both `vite dev` and `wrangler dev`), so the fail-open middleware can be exercised in dev; e2e still strips it (`playwright-e2e-in-docker-sandbox`).
- The e2e golden path (CDP virtual authenticator, in-container) covers register → reload → logout → login on this variant: `cloudflare-workers-e2e-playwright` 0.4.0.

## Scope boundary — what this skill does NOT cover

- Spaces, memberships, the `invites` table, owner-only endpoints, the race-safe invite consumption batch, and the first-space bootstrap on initial registration → `cloudflare-workers-space-membership-invite` (this skill only defines the `register/*` contract it plugs into)
- OAuth (`arctic`, Google/GitHub), the seeded-session e2e seam → `cloudflare-workers-e2e-playwright` + mazuoboeru; PATs (`Authorization: Bearer` for CLIs / agents / sibling apps, plugged in front of this session layer) → `cloudflare-workers-pat-bearer-auth`
- Rate-limit binding config, WAF alternatives, bot-scan audit → `cloudflare-workers-bot-scan-defense`
- `secureHeaders` / CSP, SPA routing, deploy pipeline → `cloudflare-workers-deploy-skeleton`
- Playwright virtual authenticator, e2e scope → `cloudflare-workers-e2e-playwright`, `playwright-e2e-in-docker-sandbox`
- Backups and point-in-time recovery of D1 → `cloudflare-d1-weekly-backup-via-pr`; table-rebuild migrations → `cloudflare-d1-drizzle-migration`
- Conditional UI (autofill passkeys), attestation verification, hardware-key-only policies, multi-RP-ID / related origins — not needed at family scale

## References

- [references/schema.md](references/schema.md) — Drizzle schema + generated SQL, storage choices, cleanup
- [references/session-and-challenge.md](references/session-and-challenge.md) — `types.ts`, cookie helpers, challenge cookie, `sessionMiddleware` with sliding expiry and the dev-bypass twin guard
- [references/auth-routes.md](references/auth-routes.md) — all `/api/auth/*` handlers, `csrfOriginCheck`, `authRateLimit`, `worker/index.ts` mount order
- [references/client-flow.md](references/client-flow.md) — `@simplewebauthn/browser` calls, error mapping, React hook
- [references/ops-and-recovery.md](references/ops-and-recovery.md) — `.dev.vars.example`, bootstrap token cycle, secret rotation, lost-passkey and forced-RP_ID-change runbooks
