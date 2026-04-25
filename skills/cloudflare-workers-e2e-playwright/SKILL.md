---
name: cloudflare-workers-e2e-playwright
description: Wire Playwright e2e tests against a Cloudflare Workers app (Hono + Vite + @cloudflare/vite-plugin) without falling into the two traps that silently break things — the strict CSP vs Vite HMR inline preamble conflict that prevents React from mounting on `page.reload()`, and the `wrangler dev --config` state-path quirk that makes the Worker query an empty D1 sqlite. Covers why you must target the build artifact via `wrangler dev` (not `vite dev`), why `--persist-to .wrangler/state` is mandatory, the WebAuthn virtual authenticator recipe (avoiding `DEV_BYPASS_USER_ID` so the registration / login wiring is actually tested), and the narrow "3 specs only" scope (golden path / cross-flow auth / security headers) that keeps e2e maintainable.
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets Cloudflare Workers with Hono + Vite + @cloudflare/vite-plugin + Playwright, optionally with WebAuthn (passkey) auth via `@simplewebauthn`. Requires wrangler CLI. Assumes you already have a working Cloudflare Workers skeleton and a strict CSP middleware in place — if not, see `cloudflare-workers-deploy-skeleton` first.
metadata:
  author: okayus
  version: "0.1.0"
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
- [ ] e2e test count stays narrow: golden path 1 + auth boundary 1 + security headers 1-3 (≤ 6 specs total)
- [ ] `.dev.vars` documented in `e2e/README.md` with the required values (`SESSION_SECRET`, any auth bootstrap tokens, `RP_ID=localhost` if WebAuthn)
- [ ] `e2e/helpers/dev-reset.ts` (or equivalent) hardcodes `--local` in every wrangler invocation to prevent accidental prod D1 wipe
- [ ] One paragraph in `playwright.config.ts` explaining **why we don't target `vite dev`** so the next person doesn't "simplify" it back

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

**Why `/` works in initial load but reloads break**: with `@cloudflare/vite-plugin@0.1.x`, `/` is served by Vite directly (the Worker is bypassed), so no Hono middleware → no CSP header → preamble runs. Any non-`/` path (including SPA fallback after `page.reload()`) goes through the Worker → middleware applies CSP → preamble blocked.

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

The virtual authenticator must be enabled **before** `page.goto()` of any auth-relevant page. RP_ID must match the page origin's hostname (`localhost` for local dev, your prod domain in prod). See [references/webauthn-virtual-authenticator.md](references/webauthn-virtual-authenticator.md) for the full helper module + .dev.vars requirements.

## Test scope philosophy: 3 specs, not 30

E2E is for "configuration / wiring", not "domain semantics". The latter belongs in unit tests. Following the principle that e2e covers what types and units cannot, narrow to:

1. **Golden path (1 spec)**: register → primary CRUD → logout. Catches WebAuthn config breakage, session cookie wiring, route → handler → DB → SPA round-trip, page reload persistence.
2. **Authorization boundary (1 spec)**: authed user attempts to access a non-member resource → server returns 404 (existence-hiding) + UI shows access-denied. Catches middleware mount-order regressions in the Hono router.
3. **Security headers (1-3 specs)**: `/`, an authenticated 401 path, and `/health` all carry the expected CSP / HSTS / X-Frame-Options / Referrer-Policy / X-Content-Type-Options. Catches `app.use("*", secureHeaders)` getting accidentally narrowed to `app.use("/api/*", ...)`.

Total: 5 test cases across 3 specs is plenty for a 2-developer / family-scale project. Resist adding more — broader coverage belongs in unit tests, not slow brittle browser tests. See [references/test-scope-philosophy.md](references/test-scope-philosophy.md) for what each test is actually catching and why other ideas (multi-space switching UX, complete history, etc.) explicitly belong in later phases.

## CI: don't run e2e in CI (initially)

WebAuthn virtual authenticator behavior occasionally diverges across Chromium versions on headless CI runners (especially `isUserVerified` propagation). For a small project, the value of CI e2e is lower than the cost of debugging flakiness. Run e2e locally before merge instead, and revisit CI integration when:

- A regression makes it to production despite local e2e passing (= local coverage is incomplete)
- The project grows beyond initial maintainers (= you need automated gating)

Document this decision explicitly in `playwright.config.ts` so the next contributor doesn't add a workflow file thinking it was an oversight.

## Scope boundary — what this skill does NOT cover

- Initial Cloudflare Workers + Vite setup — use `cloudflare-workers-deploy-skeleton` first
- Cron Trigger testing — Cron e2e is impractical (`/__scheduled` dev caveats); test the pure functions in unit and verify production firing manually via `wrangler tail`. See `cloudflare-cron-to-discord` skill
- Visual regression / screenshot diff testing — out of scope; Playwright supports it but it's a different concern
- Mocking strategies for external APIs called from the Worker — Phase 9 narrow scope assumes the Worker hits real D1 + real (testable) HTTP endpoints

## References

- [references/csp-vs-vite-hmr-preamble.md](references/csp-vs-vite-hmr-preamble.md) — full trace of the CSP × HMR preamble bug, console message to grep for, and why "relax CSP in dev" loses the regression-detection value
- [references/wrangler-state-path-quirk.md](references/wrangler-state-path-quirk.md) — physical evidence of the dual-sqlite split, `--persist-to` semantics, and how to spot it (security-headers passes but DB-touching tests fail)
- [references/webauthn-virtual-authenticator.md](references/webauthn-virtual-authenticator.md) — copy-ready CDP helper, RP_ID / .dev.vars requirements, and why DEV_BYPASS undermines e2e
- [references/test-scope-philosophy.md](references/test-scope-philosophy.md) — what the 3 specs actually verify, what they don't, and what to reject as out-of-scope
- [references/playwright-config-recipe.md](references/playwright-config-recipe.md) — full `playwright.config.ts` template with the explanatory comments inline
