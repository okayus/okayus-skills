# WebAuthn virtual authenticator for Playwright

## Why not `DEV_BYPASS_USER_ID`

A common shortcut in passkey-protected apps: add an env var that, when set, makes `sessionMiddleware` synthesize a session for a hardcoded user ID, bypassing register / login entirely. Useful for local dev. Tempting to use for e2e too.

**Don't.** If your e2e bypasses the auth wiring, you've eliminated exactly the regression coverage that a "golden path" test is supposed to provide. The whole point of an e2e test is that it exercises the production-equivalent path. An e2e against a bypass is a unit test in disguise — and you have unit tests already.

Concrete things `DEV_BYPASS_USER_ID` skips that you want e2e to catch:
- `@simplewebauthn/server` register option generation (RP_ID, challenge, exclude credentials)
- Challenge cookie sign / verify roundtrip
- `verifyRegistrationResponse` accepting the attestation
- Atomic INSERT order of `users` / `credentials` / `sessions` / `spaces` / `space_members` (any FK-order regression)
- Session JWT issuance and the `Set-Cookie` header arriving at the browser
- Login (`generateAuthenticationOptions` → `verifyAuthenticationResponse`) using the credential just registered

If any of these breaks, your bypass-based e2e passes silently. Use the virtual authenticator instead.

## Helper module

```typescript
// e2e/helpers/webauthn.ts
import type { CDPSession, Page } from "@playwright/test";

export type VirtualAuthenticator = {
  cdp: CDPSession;
  authenticatorId: string;
};

export async function enableVirtualAuthenticator(page: Page): Promise<VirtualAuthenticator> {
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
  return { cdp, authenticatorId };
}

export async function disableVirtualAuthenticator(v: VirtualAuthenticator): Promise<void> {
  await v.cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: v.authenticatorId });
}
```

Use it before any auth navigation:

```typescript
test("register → ... → logout", async ({ page }) => {
  await enableVirtualAuthenticator(page);

  await page.goto("/");                  // registration page
  await page.getByLabel(/Display name/i).fill("e2e-user");
  await page.getByRole("button", { name: /Register passkey/i }).click();
  // navigator.credentials.create() is intercepted by the virtual authenticator
  // ... rest of the flow
});
```

The virtual authenticator must be attached **before** the page issues `navigator.credentials.create` or `navigator.credentials.get`. Practically: enable it as the first action after `page.goto` of any auth-relevant page, or in a `test.beforeEach` for tests that all need auth.

## CTAP2 options explained

```typescript
{
  protocol: "ctap2",            // mandatory for resident-key flows; ctap1/u2f doesn't support it
  transport: "internal",        // simulates a platform authenticator (TouchID-like)
  hasResidentKey: true,         // required for discoverable login (no username-prompt path)
  hasUserVerification: true,    // tells the authenticator it CAN do UV
  isUserVerified: true,         // tells it the result of UV is "passed" — pretend the biometric prompt succeeded
}
```

`hasResidentKey: true` matches typical real-world passkey configs (`residentKey: "required"` in your `generateRegistrationOptions`). If your server requests `residentKey: "discouraged"`, you might see different behavior — adjust to match.

`isUserVerified: true` is the "always pretend the user passed biometric verification" knob. Without it, the authenticator returns "UV failed" and your server rejects with `userVerification: "preferred"` or `"required"`.

## RP_ID requirements

WebAuthn binds credentials to an RP_ID (the Relying Party ID, basically a domain). The browser checks that the page origin's hostname matches RP_ID. For local dev, set RP_ID to `localhost`:

```bash
# .dev.vars (gitignored)
RP_ID=localhost
ORIGIN=http://localhost:5173
```

Note this only affects local dev. Your `wrangler.jsonc` `vars.RP_ID` should be your production domain and never change after the first credential is registered (changing RP_ID invalidates all existing credentials — they're cryptographically bound to the old value). See your project's "RP_ID lock-in" ADR if you have one (this is a common ADR topic).

When you switch e2e to use `wrangler dev` instead of `vite dev`, the same `.dev.vars` is read (assuming you start wrangler from the same cwd). RP_ID still resolves to `localhost`. Browser origin is `http://localhost:5173`. The virtual authenticator uses the page's hostname as RP_ID for credential creation. Match achieved.

## In the Docker sandbox: bind `127.0.0.1`, open `localhost`

`playwright-e2e-in-docker-sandbox` says to bind `wrangler dev --ip 127.0.0.1` because a `localhost` bind stalls in-container. WebAuthn RP IDs must be domain names, so **keep the browser side on `localhost`**: `baseURL: http://localhost:<port>`, `RP_ID=localhost`, `ORIGIN=http://localhost:<port>` — Chromium resolves `localhost` to the loopback address the server is bound to, and the virtual authenticator registers / asserts normally. Only the bind address is the literal IP (verified 2026-08-30 in matatabetai: 7 specs green in-container with this split). Do not try `RP_ID=127.0.0.1`.

## Test isolation

Resident-key credentials live inside the virtual authenticator. Each Playwright test gets a fresh `BrowserContext` (and so a fresh CDP session, fresh authenticator) — no credential leakage between tests.

But your D1 database persists across tests in the same Playwright run. So:

- Reset D1 in `test.beforeAll` (or `globalSetup`) — see your project's `dev-reset.ts` helper
- Each test that registers a user gets a unique `displayName` if you want to assert on it
- Tests that depend on specific D1 state should not assume independence — call them out as serial in `test.describe.serial(...)`

## .dev.vars checklist

For a passkey + e2e setup, `.dev.vars` needs at minimum:

```
SESSION_SECRET=<openssl rand -hex 32>
RP_ID=localhost
ORIGIN=http://localhost:5173
INITIAL_REGISTRATION_TOKEN=<some-test-only-value>   # if your app gates first-user registration
```

`INITIAL_REGISTRATION_TOKEN` (or equivalent owner-bootstrap mechanism) lets the test register a fresh owner from a clean D1. In production this token is rotated out after the first real registration; in dev it stays set so e2e can reset and re-register repeatedly.

Document this in `e2e/README.md` so the next person setting up local dev knows what to put in `.dev.vars`.

## Headless CI caveat

Chromium's CDP `WebAuthn.addVirtualAuthenticator` works in headless mode, but specific behaviors (`isUserVerified` propagation, transport=`internal` vs `usb`) have shown small differences across Chromium versions on Ubuntu CI runners. If you decide to add e2e to CI later:

- Pin the Chromium version (`@playwright/test` pins by default — don't bump without re-running locally first)
- Run e2e locally and on a CI-like environment before merging the workflow file
- Be prepared to skip the virtual-authenticator tests in CI and run them only locally if flakiness becomes a problem

For the initial Phase 9 / early-stage rollout, running e2e locally only is reasonable. See the test-scope-philosophy reference for the rationale.
