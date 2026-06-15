# Third-party OAuth e2e: the seeded-session seam

The WebAuthn recipe in this skill leans on a browser primitive — the CDP virtual
authenticator — that drives the real register/login round-trip headlessly. **Third-party
OAuth (Google / GitHub / …) has no equivalent.** This reference is the OAuth-shaped
answer: don't bolt a bypass onto production; seed the session row the OAuth flow *would
have produced* and inject its cookie, so the production session middleware runs unchanged.

It is the same principle as "don't use `DEV_BYPASS_USER_ID`" — keep the production path
real — applied where no virtual authenticator exists.

## Why there is no virtual authenticator for OAuth

WebAuthn lives entirely in the browser: `navigator.credentials.create/get` is a
client-side API, so Chromium can expose a *virtual* authenticator over CDP and the whole
ceremony stays headless.

Third-party OAuth is the opposite — the part that authenticates the human happens **on
the provider, server-to-server**:

1. Your Worker redirects to `accounts.google.com` / `github.com/login/oauth/authorize`.
2. The human logs in **on the provider** and clicks *Authorize*.
3. The provider redirects back with a `code`; your Worker exchanges it
   **server→provider** (`arctic` or your own client) for tokens, then verifies email.

There is no browser knob that fakes step 2. Your OAuth *app* credentials (client id +
secret) authenticate the **application**, not a user — they can't log a person in. And the
providers deliberately block headless/automated login (bot defenses, device checks, 2FA),
so "just script the provider's login form" is brittle and against their terms. The piece
you'd want to virtualize lives on a server you don't control.

## Why not a `DEV_BYPASS` / test-login route (the same anti-pattern)

The tempting shortcut is a Worker route — gated on an env flag — that mints a session for
a hardcoded user so e2e can skip OAuth. **Don't.** It ships an authentication backdoor in
your production bundle (one misconfigured flag from being live), and it tests *nothing
real*: the session-cookie wiring an e2e exists to protect is exactly what the bypass
sidesteps. An e2e against a bypass is a unit test wearing a costume.

## The seam: seed a real session row, inject the cookie

Sessions are server state keyed by a token. So insert the **real row** your production
session store reads, computing its primary key with the **exact same scheme** the Worker
uses, then set that token as the session cookie. Production `getSessionUser` (or your
equivalent) runs byte-for-byte unchanged — no Worker code is added or modified for e2e.

Concretely, for an opaque-token-in-D1 design where the DB stores `sha256(token)` as the
session PK (so a DB leak can't be replayed):

```typescript
// worker/lib/crypto.ts (production) — stores only the HASH of the token
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// worker/auth/session.ts (production): const id = await sha256Hex(token); INSERT session(id, ...)
```

```typescript
// e2e/seed.ts — mirror that scheme EXACTLY in the seeder (node crypto, same bytes)
import { createHash } from "node:crypto";
const sessionId = (token: string): string =>
  createHash("sha256").update(token, "utf8").digest("hex"); // === production sha256Hex

// INSERT a user, then a session row whose id is sessionId(token), expires far in the future:
//   INSERT INTO session (id, user_id, created_at, last_seen_at, expires_at)
//   VALUES ('<sessionId(token)>', '<userId>', <now>, <now>, <now + 1y>);
```

```typescript
// e2e/fixtures.ts — the RAW token lives only here and in the cookie; the DB has the hash.
export const AUTHOR = { id: "e2e-user-author", token: "e2e-session-author-2f8b1c6a4d9e7035", /* … */ };
```

```typescript
// In a UI spec: inject the cookie via the browser context.
await context.addCookies([{ name: "session", value: AUTHOR.token, url: baseURL! }]);

// In an API-level spec (request fixture): a plain Cookie header — GETs are exempt from
// the CSRF Origin check, so this is enough to assert authorization boundaries.
const res = await request.get("/api/quizzes/mine", { headers: { Cookie: `session=${AUTHOR.token}` } });
```

Switching accounts mid-test (to prove a flow is genuinely cross-user — author publishes,
a **different** account challenges) is just `context.clearCookies()` then add the other
fixture's token. That is the seam paying off: two real sessions, one production path.

### Match the cookie name to the e2e scheme

A common production pattern names the cookie `__Host-session` over HTTPS (the `__Host-`
prefix *requires* `Secure`) and a plain `session` over HTTP. e2e runs on
`http://127.0.0.1`, so the production code path emits the **non-`__Host-`, non-`Secure`**
cookie — set the cookie under that name. This is the same http-vs-https fork that gives
you the dev CSP instead of the strict prod CSP (see the security-headers scope note in the
main skill): keep the whole e2e on `http://127.0.0.1` and every scheme-keyed branch stays
self-consistent.

## What the seam exercises — and what it doesn't (be honest)

**Exercised (the golden-path body, on the real path):**
- session-cookie wiring and the production `getSessionUser` resolve → user lookup → join
- route → handler → D1 → SPA round-trip; client-side routing; **persistence across a full
  `page.reload()`** (proves cookie wiring, not in-memory React state)
- server-side grading / authorization decisions (the client never receives the answer key)
- cross-user flows (publish as A → challenge as B) and existence-hiding 404s

**Not exercised (downstream of the IdP, deliberately):**
- the `code` exchange and `arctic` token parsing
- the email-verification / account-link gate
- provider-specific redirect-URI and scope config

Those belong in unit tests (mock the token response) and a one-time manual smoke against
the real provider. The seam buys you the *wiring* coverage an e2e is for, without an auth
backdoor and without a flaky dependency on github.com / accounts.google.com.

## ORIGIN / .dev.vars: no OAuth secrets required

Because the seam never performs the OAuth round-trip, **the e2e Worker needs no client id
or secret.** It needs only the vars the request path actually reads:

```
# e2e worker vars (copied over dist/.dev.vars after build — see prepare-config in the main skill)
ORIGIN=http://127.0.0.1:5399      # MUST equal Playwright baseURL or the CSRF Origin check 403s every mutation
```

`ORIGIN` matters because mutating requests are checked against it (the CSRF Origin guard);
GETs are exempt, which is why the authorization-boundary spec can assert with a bare
Cookie header. Keeping the whole run credential-free is also what lets it run in a
locked-down sandbox (see the in-container reference).

## Going further: mock the IdP (heavier, usually not worth it)

If you genuinely want the `code` exchange under test, stand up a fake IdP: point the
Worker's authorize/token URLs at a local stub that returns a canned `code` and token.
The catch is that libraries like `arctic` **hardcode each provider's endpoint URLs**, so
you must swap the provider object (or shim `fetch`) to redirect them — non-trivial, and it
still can't reproduce the provider's real consent UI. Reach for it only if OAuth-exchange
regressions have actually bitten you; otherwise the seam + unit tests on the token parser
are the better trade.

## Relationship to the WebAuthn recipe

| | WebAuthn (passkey) | Third-party OAuth |
|---|---|---|
| Where the human is authenticated | in the browser (`navigator.credentials`) | on the provider's server |
| Headless primitive available? | **Yes** — CDP virtual authenticator | **No** |
| e2e technique | drive the real register/login via the virtual authenticator | **seed the session row + inject the cookie** |
| Shared rule | never add `DEV_BYPASS` / a test-login route — keep the production path real |

Pick the row that matches your auth. If your app has both, use the virtual authenticator
for the passkey flow and the seam for the OAuth flow.
