# Client flow: `@simplewebauthn/browser` v13 in the React SPA

The browser side is three calls: `startRegistration`, `startAuthentication`, and plain `fetch` to the routes in `auth-routes.md`. Everything below is framework-light; the React hook at the end is optional.

## Version note: the `optionsJSON` wrapper

Since v11, `startRegistration` / `startAuthentication` take **an object** `{ optionsJSON }`, not the options directly. Passing the bare options (v10 style) is a runtime error in v13. The server returns `{ options }`; pass `options` as `optionsJSON`.

## `src/auth-api.ts`

```typescript
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
  WebAuthnError,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

export type AuthUser = { id: string; displayName: string };
export type ApiError = { kind: "network"; message: string } | { kind: "http"; status: number; type?: string; message: string };

// All auth calls are same-origin POSTs: the browser sends the session cookie, and the
// csrfOriginCheck middleware sees Origin === ORIGIN automatically.
async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: { type?: string; message?: string } };
    throw Object.assign(new Error(j.error?.message ?? `HTTP ${res.status}`), {
      status: res.status,
      type: j.error?.type,
    });
  }
  return (await res.json()) as T;
}

export const supportsPasskeys = (): boolean => browserSupportsWebAuthn();

// Initial owner (INITIAL_REGISTRATION_TOKEN) or invited member (inviteToken) — same two calls.
export async function register(input: {
  displayName: string;
  initialRegistrationToken?: string;
  inviteToken?: string;
  deviceName?: string;
}): Promise<AuthUser> {
  const { options } = await post<{ options: PublicKeyCredentialCreationOptionsJSON }>(
    "/api/auth/register/begin",
    input,
  );
  const response = await startRegistration({ optionsJSON: options }); // browser UI
  return post<AuthUser>("/api/auth/register/verify", { response, deviceName: input.deviceName });
}

export async function login(): Promise<AuthUser> {
  const { options } = await post<{ options: PublicKeyCredentialRequestOptionsJSON }>(
    "/api/auth/login/begin",
  );
  const response = await startAuthentication({ optionsJSON: options }); // passkey picker
  return post<AuthUser>("/api/auth/login/verify", { response });
}

export async function addDevice(deviceName: string | null): Promise<{ id: string }> {
  const { options } = await post<{ options: PublicKeyCredentialCreationOptionsJSON }>(
    "/api/auth/credentials/add/begin",
    { deviceName },
  );
  const response = await startRegistration({ optionsJSON: options });
  return post<{ id: string }>("/api/auth/credentials/add/verify", { response, deviceName });
}

export const logout = () => post<Record<string, never>>("/api/auth/logout");

export async function me(): Promise<AuthUser | null> {
  const res = await fetch("/api/auth/me");
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as AuthUser;
}

// --- error mapping ------------------------------------------------------------------------
// @simplewebauthn wraps DOMExceptions in WebAuthnError { code, cause }. UNVERIFIED: diff the
// `code` strings against the installed version's WebAuthnErrorCode type.
export function describeAuthError(e: unknown): string {
  if (e instanceof WebAuthnError) {
    const domName = (e.cause as { name?: string } | undefined)?.name;
    switch (e.code) {
      case "ERROR_CEREMONY_ABORTED": // NotAllowedError: user cancelled, timed out, or no gesture
        return "Cancelled or timed out — try again from the button.";
      case "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED": // InvalidStateError: excludeCredentials hit
        return "This device already has a passkey for this account.";
      case "ERROR_INVALID_RP_ID": // SecurityError: RP_ID is not this page's host
        return "Server RP_ID does not match this site's hostname.";
      case "ERROR_INVALID_DOMAIN": // not a secure context / invalid effective domain
        return "Passkeys need HTTPS (or localhost).";
      default:
        return `${e.code}${domName ? ` (${domName})` : ""}: ${e.message}`;
    }
  }
  if (e instanceof Error && "status" in e) {
    const { status, type } = e as Error & { status: number; type?: string };
    if (status === 403 && type === "registration_closed") return "Registration is closed.";
    if (status === 410) return "This invite was already used or has expired.";
    if (status === 429) return "Too many attempts — wait a minute.";
    return e.message;
  }
  return String(e);
}
```

## What each DOMException means in dev

| `cause.name` | Usually means | Fix |
|---|---|---|
| `SecurityError` | `RP_ID` ≠ page hostname (prod value leaking into local dev, or `127.0.0.1` vs `localhost`) | `.dev.vars` `RP_ID=localhost`, open the app on `http://localhost:<port>` |
| `NotAllowedError` | user dismissed the sheet, 60 s timeout, call not from a user gesture (Safari), or no matching passkey on this device for login | call from a click handler; for login, register this device first |
| `InvalidStateError` | authenticator already has a credential listed in `excludeCredentials` | that's the intended duplicate guard — tell the user |
| `NotSupportedError` | no platform authenticator / algorithm mismatch | `browserSupportsWebAuthn()` gate; keep default `pubKeyCredParams` |
| verify `400 challenge_mismatch` while `begin` was `200` | `ORIGIN` ≠ browser origin (port/scheme), or the 5-min challenge cookie expired/was dropped (`secure` over http) | check `ORIGIN` and cookie attributes before touching ceremony code |

Always trigger ceremonies from a user gesture (button click). UNVERIFIED whether current Safari still requires it; a click handler is correct on every browser regardless.

## React hook (optional shape)

```typescript
import { useCallback, useEffect, useState } from "react";
import * as authApi from "./auth-api";

type State =
  | { status: "loading" }
  | { status: "anonymous" }
  | { status: "authed"; user: authApi.AuthUser };

export function useAuth() {
  const [state, setState] = useState<State>({ status: "loading" });
  const refresh = useCallback(async () => {
    const user = await authApi.me();
    setState(user ? { status: "authed", user } : { status: "anonymous" });
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    state,
    login: async () => setState({ status: "authed", user: await authApi.login() }),
    register: async (input: Parameters<typeof authApi.register>[0]) =>
      setState({ status: "authed", user: await authApi.register(input) }),
    logout: async () => {
      await authApi.logout();
      setState({ status: "anonymous" });
    },
    refresh,
  };
}
```

Any API call that returns `401` should reset the state to `anonymous` (a session was revoked elsewhere or expired); nyalog does this with a tiny `user-invalid` event bus so every fetch wrapper can trigger it without importing React.

## Invite landing page

`/invite?token=…` (the link the owner shares) renders the register form with `inviteToken` pre-filled and asks only for `displayName` + optional `deviceName`. The token is consumed at `register/verify`, so a user who cancels the passkey sheet can retry with the same link. Token semantics (TTL, single use, 403/410 codes) come from `cloudflare-workers-space-membership-invite`.
