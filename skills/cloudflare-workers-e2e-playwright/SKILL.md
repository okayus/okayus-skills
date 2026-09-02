---
name: cloudflare-workers-e2e-playwright
description: Wire Playwright e2e tests against a Cloudflare Workers app (Hono + Vite + @cloudflare/vite-plugin) without falling into the two traps that silently break things — the strict CSP vs Vite HMR inline preamble conflict that prevents React from mounting (on `page.reload()` with vite-plugin 0.1.x; from the initial load on 1.x), and the `wrangler dev --config` state-path quirk that makes the Worker query an empty D1 sqlite. Covers why you must target the build artifact via `wrangler dev` (not `vite dev`), why `--persist-to .wrangler/state` is mandatory, the WebAuthn virtual authenticator recipe (no `DEV_BYPASS_USER_ID` shortcut — the real register/login wiring is tested), the seeded-session seam for third-party OAuth apps (seed a real session row + inject its cookie; OAuth has no virtual authenticator), the narrow "3 specs only" scope (golden path / auth boundary / security headers), the `.dev.vars` copy that `@cloudflare/vite-plugin` 1.x writes into `dist/<worker>/` (it silently overrides your e2e vars), the unread-request-body trap that makes `wrangler dev` answer the NEXT request with a 500 and exit (never send a body to a route that rejects before reading it), a dedicated e2e state dir so runs never wipe `pnpm dev` data, and type-checking the specs in CI with `tsconfig.e2e.json` even though e2e itself does not run there. For running the suite credential-free inside a Docker sandbox, see the companion skill playwright-e2e-in-docker-sandbox.
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets Cloudflare Workers with Hono + Vite + @cloudflare/vite-plugin + Playwright, with either WebAuthn (passkey) auth via `@simplewebauthn` OR third-party OAuth (Google / GitHub, e.g. via `arctic`). Requires wrangler CLI. Assumes you already have a working Cloudflare Workers skeleton and a strict CSP middleware in place — if not, see `cloudflare-workers-deploy-skeleton` first.
metadata:
  author: okayus
  version: "0.4.0"
---

# Cloudflare Workers + Playwright e2e (without the two silent traps)

**The two traps in one sentence**: pointing Playwright at `pnpm dev` (Vite) makes Vite's HMR inline preamble collide with your strict CSP and prevents React from mounting on any non-`/` path; switching to `wrangler dev --config dist/.../wrangler.json` then makes the Worker query a *different empty* D1 sqlite (silently, no migrations) unless you pass `--persist-to .wrangler/state`.

This skill exists because the author burned several hours debugging both traps in sequence on a single Phase 9 PR. Each trap looks like a different bug — CSP says "inline script blocked", D1 says "no such table: users" — but the root cause for both is the same: **the dev-mode plumbing that's convenient for interactive iteration silently diverges from production semantics**, and e2e is exactly where that divergence shows up.

## When to use this skill

- You're adding Playwright e2e to a Cloudflare Workers + Vite + React project
- Your app has a strict `script-src 'self'` CSP applied via Hono middleware (`secureHeaders`)
- You're seeing one or more of:
  - `Executing inline script violates Content Security Policy` in the browser console after `page.reload()`
  - `D1_ERROR: no such table: users` when register / login hits the DB during e2e
  - Tests that pass against `vite dev` but fail in CI / production-like environments
  - WebAuthn / passkey flows that you want to automate without bypassing them
- Your auth is **third-party OAuth** (Google / GitHub) and you can't see how to e2e it without shipping a login bypass — there's no virtual authenticator for OAuth (see the seeded-session seam below)
- You develop in a network-isolated **Docker sandbox** (egress firewall, no host browser, no Cloudflare login) and want the suite to run fully in-container
- You want to scope e2e narrowly per the "configuration not exhaustive" testing philosophy

Do **not** use for:
- Pure SPA projects without a Worker (no D1, no Hono middleware) — Vite dev server e2e works fine
- Projects without a strict CSP — the HMR preamble conflict doesn't trigger
- Apps where you've already accepted `'unsafe-inline'` in production CSP — different threat model

## Deliverables (completion criteria)

- [ ] `playwright.config.ts` with `webServer.command: "pnpm run e2e:server"` (NOT `pnpm dev`)
- [ ] `package.json` script: `"e2e:server": "pnpm build && pnpm exec wrangler dev --config dist/<bundle>/wrangler.json --persist-to .wrangler/state --port <port>"`
- [ ] All `console.error()` calls in security-relevant middleware (auth / authorization 404) verified to NOT leak in production but show correctly during e2e
- [ ] WebAuthn-using golden-path test uses CDP virtual authenticator, NOT `DEV_BYPASS_USER_ID`
- [ ] OAuth-using golden-path test uses the **seeded-session seam** (seed a real session row keyed exactly as production keys it, inject the cookie), NOT a `DEV_BYPASS` / test-login route — no Worker code added or modified for e2e
- [ ] e2e test count stays narrow: golden path 1 + auth boundary 1 + security headers 1-3 (≤ 6 specs total)
- [ ] `.dev.vars` (or e2e-specific vars) documented in `e2e/README.md` with the required values (`SESSION_SECRET`, any auth bootstrap tokens, `RP_ID=localhost` if WebAuthn; `ORIGIN` = `baseURL` if OAuth — note the seam needs **no** OAuth client secrets)
- [ ] `e2e/helpers/dev-reset.ts` / `seed.ts` (or equivalent) hardcodes `--local` in every wrangler invocation to prevent accidental prod D1 wipe
- [ ] The `.dev.vars` copy in `dist/<bundle>/` is neutralised (deleted by a prepare step, or every key passed with `--var`) — Trap 2b
- [ ] No spec sends a request body to a route that rejects before reading it (session 401 / CSRF 403) — Trap 3
- [ ] `tsconfig.e2e.json` (`types: ["node"]`) is part of `pnpm check`, so CI type-checks `e2e/**` and `playwright.config.ts` even though e2e does not run there
- [ ] One paragraph in `playwright.config.ts` explaining **why we don't target `vite dev`** so the next person doesn't "simplify" it back
- [ ] If running in a Docker sandbox: follow the companion skill [`playwright-e2e-in-docker-sandbox`](../playwright-e2e-in-docker-sandbox/SKILL.md) (baked browser, stripped rate-limit binding, `--ip 127.0.0.1`, gated `--no-sandbox`)

## Trap 1: Strict CSP vs Vite HMR inline preamble

`@vitejs/plugin-react` injects an inline `<script>` into every HTML response in dev mode to bootstrap React Fast Refresh:

```html
<script type="module">
  import RefreshRuntime from "/@react-refresh";
  RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
  window.__vite_plugin_react_preamble_installed__ = true;
</script>
```

Your production CSP (`script-src 'self'`) blocks this inline script. React then fails to bootstrap and the page never mounts. Symptoms: `page.reload()` in Playwright completes, the URL changes, but no `/api/*` calls are made and assertions for any UI text time out.

**Why `/` works in initial load but reloads break**: with `@cloudflare/vite-plugin@0.1.x`, `/` is served by Vite directly (the Worker is bypassed), so no Hono middleware → no CSP header → preamble runs. Any non-`/` path (including SPA fallback after `page.reload()`) goes through the Worker → middleware applies CSP → preamble blocked. (On `@cloudflare/vite-plugin@1.x` the Worker serves `/` too, so the preamble can be blocked from the **initial** load — same diagnosis, same fix.)

**Why "relax CSP in dev" is the wrong fix**: it makes your dev CSP differ from prod CSP, so the e2e isn't actually testing the prod configuration. The whole point of e2e is to verify wiring as it ships.

**The correct fix**: target the build artifact, not the dev server. The built `index.html` doesn't have the HMR preamble (it's only injected by Vite dev) so strict CSP is fine. See [references/csp-vs-vite-hmr-preamble.md](references/csp-vs-vite-hmr-preamble.md) for the full diagnosis trace.

## Trap 2: `wrangler dev --config` state path divergence

Once you switch e2e to `wrangler dev --config dist/<bundle>/wrangler.json`, you might see:

```
D1_ERROR: no such table: users: SQLITE_ERROR
```

This is because `wrangler dev` resolves `.wrangler/state/v3/d1/*.sqlite` (the local D1 file) **relative to the config file's directory** when `--config` is passed, not relative to the cwd. Since the build emits a fresh wrangler.json into `dist/`, wrangler creates a brand-new empty sqlite at `dist/<bundle>/.wrangler/state/v3/d1/*.sqlite`. Your migrations were applied to `packages/<pkg>/.wrangler/state/...` (cwd-relative, where `pnpm db:migrate` ran) — completely different file.

Symptom progression to recognize the trap: tests that don't touch the DB (security headers, `/health`) pass; tests that do touch the DB (register, login, any authenticated route) fail with sqlite "no such table" errors.

**The fix**: pass `--persist-to .wrangler/state` to pin the state directory to the cwd-relative path, matching where migrations were applied.

```bash
pnpm exec wrangler dev \
  --config dist/<bundle>/wrangler.json \
  --persist-to .wrangler/state \
  --port 5173
```

See [references/wrangler-state-path-quirk.md](references/wrangler-state-path-quirk.md) for the physical evidence (`du -sh dist/<bundle>/.wrangler/`) and how to detect the trap.

**Variant — a dedicated e2e state dir.** The requirement is "server and helper commands look at the same sqlite", not the literal `.wrangler/state`. kokemusu (2026-09-02) points both at `--persist-to .wrangler/e2e`: `globalSetup` runs `wrangler d1 migrations apply <db> --local --persist-to .wrangler/e2e` (idempotent, creates the file on first run) and then empties every table, so a run starts from "no user, no rows" and **never touches the `pnpm dev` database** (its registered passkeys and posts survive). One constant (`E2E_PERSIST_DIR` in `e2e/env.ts`) feeds the db helper; the `e2e:server` script repeats it on the command line.

**Trap 2b — the `.dev.vars` copy.** `@cloudflare/vite-plugin` 1.x copies `.dev.vars` into `dist/<bundle>/.dev.vars` at build time, and wrangler reads `.dev.vars` from the directory of the config it was given — the same config-relative rule as the state path. So the e2e server silently runs with the developer's `DEV_CSP=1` (relaxed CSP → the security spec fails) and dev `ORIGIN` (→ 403 on every POST, `challenge_mismatch` on verify). Fix in the prepare step: delete `dist/<bundle>/.dev.vars` and write the e2e values into the derived config's `vars`, or pass every key with `--var` (CLI `--var` outranks the copy; measured precedence `--var` > `.dev.vars` > `vars`). Verified 2026-09-02 in kokemusu (vite-plugin 1.53, wrangler 4.125).

## Trap 3: a request body the Worker never reads kills `wrangler dev`

Symptom: one spec passes, the next one's first request (or the next request from `curl`) is a **500 `Network connection lost`**, and `wrangler dev` prints `✘ [ERROR]` and exits — every later spec fails with `ECONNREFUSED`.

Cause: the previous request carried a body (a JSON POST) and the Worker answered **before reading it** — exactly what a session gate (401) or a CSRF check (403) does. `wrangler dev`'s ProxyWorker → user-worker hop keeps that connection pooled, the runtime closes it because of the unread body, and the next request through the proxy dies on the stale connection (`entry.worker.js` `fetch` → `Network connection lost`); wrangler treats the ProxyWorker error as fatal. Reproduced deterministically with curl on wrangler **4.125.0 and 4.128.0** (2026-09-02, kokemusu):

```bash
curl -X POST -H 'Origin: http://localhost:5183' -H 'Content-Type: application/json' \
     --data '{"body":"x"}' http://127.0.0.1:5183/api/posts        # 401, body unread
curl -X POST -H 'Origin: http://localhost:5183' http://127.0.0.1:5183/api/auth/logout
#   → 500 Network connection lost, then wrangler dev exits
```

Production workerd does not care — returning early without draining the body is normal and correct there — so **do not change the Worker** for this (no defensive `await c.req.text()` in the session middleware). The rule lives in the specs: **never send a body to a route that rejects before reading it**. An auth-boundary spec asserts `POST /api/posts` → 401 *without* `data:`; the outcome is identical because the gate answers first. Requests whose body *is* read before the reply (register/begin parsing JSON before a 403 on a wrong token, a validation 400 after `c.req.json()`) are fine. Upgrading wrangler does not help (4.128.0 behaves the same); write the rule into `e2e/README.md`.

## WebAuthn (passkey) automation

If your app uses WebAuthn, **do not** add a `DEV_BYPASS_USER_ID` shortcut just to make e2e easier. That bypasses `sessionMiddleware` / register / login entirely, so the e2e provides zero regression coverage for the wiring you most want to protect.

Use Playwright's CDP `WebAuthn.addVirtualAuthenticator` instead. It works headlessly, lives in the browser context, and exercises the real `@simplewebauthn/browser` → `@simplewebauthn/server` round-trip:

```typescript
const cdp = await page.context().newCDPSession(page);
await cdp.send("WebAuthn.enable");
const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
  options: {
    protocol: "ctap2",
    transport: "internal",
    hasResidentKey: true,
    hasUserVerification: true,
    isUserVerified: true,
  },
});
```

The virtual authenticator must be enabled **before** `page.goto()` of any auth-relevant page. RP_ID must match the page origin's hostname (`localhost` for local dev, your prod domain in prod). In the Docker sandbox bind the server to `127.0.0.1` but keep `baseURL` / `ORIGIN` / `RP_ID` on `localhost` (verified 2026-08-30 in matatabetai — see the reference). See [references/webauthn-virtual-authenticator.md](references/webauthn-virtual-authenticator.md) for the full helper module + .dev.vars requirements.

Verified 2026-09-02 in kokemusu (single-user passkey variant, in-container): one spec does register (token-gated, `residentKey: "required"`, `userVerification: "preferred"`) → `page.reload()` → a write → logout → login by discoverable credential against the same virtual authenticator, in about a second; 10 tests across the 3 specs green twice in a row.

## Third-party OAuth (Google / GitHub): the seeded-session seam

If login is **third-party OAuth** rather than WebAuthn, you hit a wall: there is **no
virtual authenticator for OAuth**. WebAuthn lives in the browser, so Chromium can fake it
over CDP; OAuth authenticates the human **on the provider's server** (the `code` is
exchanged server→`accounts.google.com` / `github.com`), and providers block headless
login. Your OAuth *app* credentials authenticate the application, not a user — they can't
log anyone in.

The **same rule as WebAuthn** still applies: do **not** bolt a `DEV_BYPASS` / test-login
route onto the Worker. That ships an auth backdoor in production and tests nothing real.

Instead, use the **seeded-session seam**: insert the real `session` row the OAuth flow
*would have produced*, computing its key with the **exact scheme production uses**, then
inject that token as the session cookie. Production session middleware (`getSessionUser`)
runs byte-for-byte unchanged — **no Worker code is added or modified for e2e**.

```typescript
// seed.ts mirrors the production key scheme EXACTLY. Example: the DB stores sha256(token)
// as session.id (so a DB leak can't be replayed), so the seeder hashes the same bytes:
const sessionId = (token: string) => createHash("sha256").update(token, "utf8").digest("hex");
// → INSERT INTO session (id, user_id, expires_at, …) VALUES (sessionId(token), userId, far_future, …)

// A UI spec injects the cookie; switching the token mid-test proves a flow is cross-user.
await context.addCookies([{ name: "session", value: AUTHOR.token, url: baseURL! }]);
// An API spec can send a bare Cookie header (GETs are exempt from the CSRF Origin check):
await request.get("/api/quizzes/mine", { headers: { Cookie: `session=${AUTHOR.token}` } });
```

This exercises the golden-path body on the real path — session wiring, route→handler→D1→SPA
round-trip, `page.reload()` persistence, **server-side grading**, cross-user 404s — while
deliberately skipping only the IdP round-trip itself (the `code` exchange + email gate),
which belongs in unit tests + a one-time manual smoke. It needs **no OAuth client
secrets**, which is also what lets the whole run go credential-free in a sandbox. Match the
cookie **name** to the e2e scheme (e.g. `session` over http vs `__Host-session` over
https). See [references/oauth-seeded-session-seam.md](references/oauth-seeded-session-seam.md)
for the full recipe, the honest exercised/not-exercised split, and the heavier "mock the
IdP" option (and why `arctic`'s hardcoded URLs make it rarely worth it).

## Test scope philosophy: 3 specs, not 30

E2E is for "configuration / wiring", not "domain semantics". The latter belongs in unit tests. Following the principle that e2e covers what types and units cannot, narrow to:

1. **Golden path (1 spec)**: register → primary CRUD → logout. Catches WebAuthn config breakage, session cookie wiring, route → handler → DB → SPA round-trip, page reload persistence.
2. **Authorization boundary (1 spec)**: authed user attempts to access a non-member resource → server returns 404 (existence-hiding) + UI shows access-denied. Catches middleware mount-order regressions in the Hono router.
3. **Security headers (1-3 specs)**: `/`, an authenticated 401 path, and `/health` all carry the expected CSP / HSTS / X-Frame-Options / Referrer-Policy / X-Content-Type-Options. Catches `app.use("*", secureHeaders)` getting accidentally narrowed to `app.use("/api/*", ...)`. Scope note: assert the values your middleware emits **for the e2e scheme** — e2e runs on `http://127.0.0.1`, so scheme-keyed branches (a dev CSP over http, `__Host-` cookies / HSTS only over https) must be asserted in their http form. The flip side: http e2e is **structurally blind** to https-only failures — hono throws when a `__Host-` cookie is written (deletion included) without `secure`, and that reached kokemusu production unseen (#15) because vite dev, unit tests *and* e2e all run on http. Keep one unit test per cookie-clearing path with an https `ORIGIN`; e2e cannot stand in for it.

Total: 5 test cases across 3 specs is plenty for a 2-developer / family-scale project. Resist adding more — broader coverage belongs in unit tests, not slow brittle browser tests. See [references/test-scope-philosophy.md](references/test-scope-philosophy.md) for what each test is actually catching and why other ideas (multi-space switching UX, complete history, etc.) explicitly belong in later phases.

## Keeping the golden path's locators stable as the UI grows

The golden path is one spec that keeps getting longer as features land, and its page-wide
locators break for reasons that have nothing to do with the feature under test. Two that
cost real time (verified 2026-09-02 in matatabetai, adding a "recent dishes" suggestion
strip to a form that sits above the list of the same records):

**1. The same entity name now renders twice → strict mode violation.** `page.getByText("肉じゃが",
{ exact: true })` passed for months, then a suggestion chip started rendering the same dish
name above the feed and every assertion in the spec failed at once. Don't reach for `.first()`
— that hides which one you meant. Name the containers and scope to them:

```tsx
<form aria-labelledby="mealFormHeading">   <h2 id="mealFormHeading">たべたものを記録</h2>
<section aria-labelledby="feedHeading">    <h2 id="feedHeading">みんなの記録</h2>
```
```ts
const form = page.getByRole("form", { name: "たべたものを記録" });   // named <form> → role=form
const feed = page.getByRole("region", { name: "みんなの記録" });     // named <section> → role=region
await expect(feed.getByText("肉じゃが", { exact: true })).toBeVisible();
```

An unnamed `<section>` has no role at all, so this costs one `aria-labelledby` per landmark —
and it makes the page navigable by landmark for screen readers, which you wanted anyway.

**2. Accessible names get a space at every element boundary.** The common pattern of appending
a visually-hidden qualifier to a short label —

```tsx
<button>削除<span className="visually-hidden">（{meal.name}）</span></button>
```

— computes to `削除 （カレー）`, **not** `削除（カレー）`, so `getByRole("button", { name: "削除（カレー）" })`
waits forever. In CJK UIs there is no other whitespace to hint at this. Use a regex
(`{ name: /削除.*カレー/ }`) rather than trying to guess the joiner, and when a locator times out
on a name you are sure is on screen, read the ARIA snapshot in the failure's
`error-context.md` — it prints the computed name and settles it in seconds.

## CI: don't run e2e in CI (initially)

WebAuthn virtual authenticator behavior occasionally diverges across Chromium versions on headless CI runners (especially `isUserVerified` propagation). For a small project, the value of CI e2e is lower than the cost of debugging flakiness. Run e2e locally before merge instead, and revisit CI integration when:

- A regression makes it to production despite local e2e passing (= local coverage is incomplete)
- The project grows beyond initial maintainers (= you need automated gating)

Document this decision explicitly in `playwright.config.ts` so the next contributor doesn't add a workflow file thinking it was an oversight.

What CI *should* do is type-check the specs: `tsc` on the app's tsconfig never sees `e2e/**`, so an API-shape change can break a spec silently until someone runs it locally. Add a `tsconfig.e2e.json` that extends the app config with `"types": ["node"]` (the helpers use `node:child_process`; do not add Node's globals to the Worker's config) and `"include": ["e2e/**/*", "playwright.config.ts"]`, and append `tsc --noEmit -p tsconfig.e2e.json` to the `check` script CI already runs. Cost: `@types/node` as a devDependency. Verified 2026-09-02 in kokemusu.

## Running e2e inside a Docker sandbox (credential-free)

The whole suite can run in-container with **zero runtime egress**: bake Chromium at
image-build time (build runs before the firewall), strip the rate-limit binding from the
built config, and bind `--ip 127.0.0.1`. The recipe — plus the two sandbox-only traps that
make a credential-free `wrangler dev` hang at connect-but-no-response — lives in the
companion skill
[`playwright-e2e-in-docker-sandbox`](../playwright-e2e-in-docker-sandbox/SKILL.md).
The seeded-session seam above is what makes the run need no OAuth secrets in the first
place.

## Scope boundary — what this skill does NOT cover

- Initial Cloudflare Workers + Vite setup — use `cloudflare-workers-deploy-skeleton` first
- Cron Trigger testing — keep Cron out of Playwright e2e; test the pure functions in unit tests, poke the local scheduled endpoint (`/cdn-cgi/handler/scheduled`) by hand when needed, and verify production firing via `wrangler tail`. See `cloudflare-cron-to-discord` skill
- Visual regression / screenshot diff testing — out of scope; Playwright supports it but it's a different concern
- Mocking strategies for external APIs called from the Worker — Phase 9 narrow scope assumes the Worker hits real D1 + real (testable) HTTP endpoints

## References

- [references/csp-vs-vite-hmr-preamble.md](references/csp-vs-vite-hmr-preamble.md) — full trace of the CSP × HMR preamble bug, console message to grep for, and why "relax CSP in dev" loses the regression-detection value
- [references/wrangler-state-path-quirk.md](references/wrangler-state-path-quirk.md) — physical evidence of the dual-sqlite split, `--persist-to` semantics, and how to spot it (security-headers passes but DB-touching tests fail)
- [references/webauthn-virtual-authenticator.md](references/webauthn-virtual-authenticator.md) — copy-ready CDP helper, RP_ID / .dev.vars requirements, and why DEV_BYPASS undermines e2e
- [references/oauth-seeded-session-seam.md](references/oauth-seeded-session-seam.md) — the OAuth equivalent (no virtual authenticator exists): seed a real session row + inject the cookie, the exercised/not-exercised split, cookie-name-vs-scheme, and the heavier "mock the IdP" option
- In-sandbox execution (baked Chromium, the two credential-free `wrangler dev` hang traps) — moved to the companion skill [`playwright-e2e-in-docker-sandbox`](../playwright-e2e-in-docker-sandbox/SKILL.md)
- [references/test-scope-philosophy.md](references/test-scope-philosophy.md) — what the 3 specs actually verify, what they don't, and what to reject as out-of-scope
- [references/playwright-config-recipe.md](references/playwright-config-recipe.md) — full `playwright.config.ts` template with the explanatory comments inline, plus the kokemusu variant (dedicated state dir, `env.ts` + `prepare-config.ts` run by plain `node`, `tsconfig.e2e.json`)
