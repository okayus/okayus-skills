# Test scope philosophy: 3 specs, not 30

## What e2e is for, and what it isn't

Per the testing principle "unit tests express what code MEANS, e2e tests express that code IS WIRED", an e2e suite is **not** the place to:

- Cover edge cases of pure functions (use unit tests)
- Test individual handler error paths (use unit tests with mocked HTTP)
- Verify input validation rules (use Zod / parser unit tests)
- Cover all UI states of all pages (use component tests if needed, or accept manual smoke)

E2e is the place to verify that **independently-correct pieces are connected the way you think they are**. Connection-level regressions are exactly what type checking and unit tests cannot catch.

## The three concrete categories

For a Cloudflare Workers + Vite + auth app, three categories of e2e cover the connections that matter:

### 1. Golden path (1 spec)

A single happy-path scenario that exercises every layer end-to-end. For a typical auth + CRUD app:

```
register → login → create primary entity → reload (verify persistence) → modify → delete → logout
```

**What this catches**:
- WebAuthn (or password / OAuth) wiring with the actual SDK versions you ship
- Session cookie issuance + browser → server roundtrip
- Server middleware chain (auth → authorization → handler)
- Database migration coverage (every table touched by happy path is exercised)
- SPA → API contract (request body shape, response shape, error format)
- Client-side routing on success transitions
- D1 persistence across page reloads (the `page.reload()` step is non-negotiable; it catches "data sent to server but not committed" bugs)

**What this doesn't catch**:
- Permissions edge cases (covered separately — see category 2)
- Security configuration (covered separately — see category 3)
- Domain logic correctness (units handle this)

### 2. Authorization boundary (1 spec)

The most security-critical regression category. For per-tenant or per-resource authorization:

```
register a user → authenticate → attempt to access a resource the user doesn't own → expect 404 (not 403)
```

The 404 vs 403 detail is important — leaking "this resource exists, you just can't see it" via 403 is an information disclosure bug. Modern apps prefer existence-hiding 404s.

**What this catches**:
- Middleware mount order in the Hono router (forgetting to put `spaceMiddleware` on a new route)
- Authorization predicate logic at the runtime boundary (the unit test on the predicate doesn't see how it's wired)
- UI fallback handling when the API returns a 404 (does the UI show "no access" instead of crashing?)

**What this doesn't catch**:
- The internal logic of the authorization predicate (covered in unit)
- Multi-step authorization chains (e.g., revoking access mid-session) — those need their own tests if they matter

### 3. Security configuration (1-3 specs)

Verifies that security middleware is mounted and applied consistently:

```
GET /                        → expect 200 with all 5 security headers
GET /api/auth/me (no cookie) → expect 401 with all 5 security headers
GET /health                  → expect 200 with all 5 security headers
```

**What this catches**:
- `app.use("*", secureHeaders)` accidentally narrowed to `app.use("/api/*", ...)` — the `/` test fails
- CSP directive value drift (a refactor changes `script-src 'self'` to `script-src 'self' 'unsafe-inline'`) — assertions on specific values fail
- Header response not present on error paths — the 401 test catches this
- Header missing on health checks (often forgotten when adding a new health endpoint)

**What this doesn't catch**:
- The CSP actually preventing XSS — that's a property test, not e2e
- HSTS preload status — operational, not e2e

## What to reject as out-of-scope

Common urges to expand the e2e suite that should be resisted:

| Idea | Why reject |
|---|---|
| "Test multi-tenant switching UX" | Domain workflow — unit + manual smoke |
| "Test the empty state of every page" | Component story — manual or component tests |
| "Test rate limiting" | Operational, requires real backpressure to verify |
| "Test all error toast messages" | UI presentation, not wiring |
| "Test the registration validation rules (min length, special chars, ...)" | Unit on the parser |
| "Test that copy-link button copies the right URL" | Component-level, not wiring |
| "Test pagination on long lists" | Domain logic, can be unit-tested |
| "Test cron firing → notification delivery" | Cron tests don't work in dev (`/__scheduled` caveat); manual prod smoke instead |

The reject list should grow over time as you encounter more "should we add this?" questions. Add the question + the rejection reason to your test-scope doc, so future you doesn't relitigate the same decision.

## Counting test cases

For a 2-developer / family-scale project, **5 test cases across 3 specs** is plenty. Concretely:

- 1 golden-path spec, 1 test case
- 1 auth-boundary spec, 1 test case
- 1 security-headers spec, 3 test cases (`/`, `/api/auth/me`, `/health`)

Total: 5 test cases, ~25 seconds total runtime.

If you find yourself wanting more, ask: "Does this catch a connection-level regression that no unit test could?" If no, it's a unit test in disguise — move it. If yes, it might be valid, but write down what category of failure it catches before accepting it into the suite.

## CI strategy: deferred

For early-stage projects, **don't add e2e to CI on day one**. Reasons:

- WebAuthn virtual authenticator behavior occasionally diverges across Chromium versions on headless CI
- A flaky e2e in CI blocks merges and creates pressure to weaken the test
- Running e2e locally before merge gives you 90% of the value at zero CI complexity

Add to CI when:
- A regression makes it past local e2e to production (= you need automated gating)
- Multiple developers can't reliably run e2e locally (= you need a shared environment)

Document this decision in your `playwright.config.ts` so the next person doesn't add a workflow file thinking it was an oversight.

## When to expand

Triggers for adding test cases:
- A bug shipped that no existing unit test would have caught + the bug spanned >1 layer (= e2e is the right level)
- A new auth provider or session mechanism (= the golden path needs to exercise it)
- A new authorization predicate (= the boundary test needs a case for it)

Triggers for adding test specs:
- A new top-level user role with a fundamentally different golden path
- A new cross-cutting concern (audit logging? data export?) — but think hard whether it's really e2e

Don't expand "just because we have time". Brittle e2e is worse than no e2e, because it teaches the team that test failures don't mean anything.

## Generalizable lesson

The temptation to test everything via e2e is high because e2e looks like "the most realistic test". It is — but realism comes at the cost of speed, debuggability, and maintenance burden. Each e2e spec is a tax on every PR.

Pay the tax for connections that matter. Don't pay it for things you can verify cheaper elsewhere. The 3-category scope above is one defensible split for a typical web app — adapt the categories, but keep the count tiny.
