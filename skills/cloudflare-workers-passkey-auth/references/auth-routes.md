# Auth routes, CSRF check, rate limit, mount order

`worker/routes/auth.ts` plus two middlewares and the `worker/index.ts` wiring. Error shape everywhere: `{ error: { type, message? } }`. Input parsing uses zod schemas from `worker/domain/auth.ts` (names below); swap in your own validator if you don't use zod/neverthrow.

## Byte helpers (`worker/lib/base64url.ts`)

```typescript
export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(s: string): Uint8Array<ArrayBuffer> {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// TS >= 5.7 types TextEncoder.encode() as Uint8Array<ArrayBufferLike>; @simplewebauthn's
// `userID` / `publicKey` parameters want Uint8Array<ArrayBuffer>. Copy into a fresh buffer.
export function utf8Bytes(s: string): Uint8Array<ArrayBuffer> {
  const src = new TextEncoder().encode(s);
  const out = new Uint8Array(new ArrayBuffer(src.byteLength));
  out.set(src);
  return out;
}
```

## `worker/middleware/rate-limit.ts`

```typescript
import { createMiddleware } from "hono/factory";
import type { Env } from "../types";

// Binding + limits live in wrangler.jsonc `ratelimits` — see cloudflare-workers-bot-scan-defense
// (30 req / 60 s per IP is enough for a family and still stops scanners).
export const authRateLimit = createMiddleware<Env>(async (c, next) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.AUTH_RATE_LIMITER.limit({ key: ip });
  if (!success) {
    return c.json({ error: { type: "rate_limited", message: "Too many requests" } }, 429);
  }
  await next();
});
```

## `worker/middleware/csrf.ts`

```typescript
import { createMiddleware } from "hono/factory";
import type { Env } from "../types";

// SameSite=Lax already blocks cross-site POST from navigations; this closes the rest.
// GET/HEAD/OPTIONS are exempt so `<img>`-style loads and e2e API reads with a bare Cookie work.
export const csrfOriginCheck = createMiddleware<Env>(async (c, next) => {
  const m = c.req.method;
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
    const origin = c.req.header("Origin");
    if (!origin || origin !== c.env.ORIGIN) {
      return c.json({ error: { type: "csrf_origin_mismatch" } }, 403);
    }
  }
  await next();
});
```

## `worker/routes/auth.ts`

```typescript
import { and, count, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { type Context, Hono } from "hono";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { credentials, users, type NewCredential } from "../db/schema";
import {
  type AuthError,
  UserId,
  authErrorResponse, // AuthError -> { body, status }
  parseBeginRegistration, // { displayName, initialRegistrationToken?, inviteToken? }
  parseVerifyRegistration, // { response, deviceName? }
  parseVerifyLogin, // { response }
  parseAddCredentialBegin, // { deviceName? }
  parseAddCredentialVerify, // { response, deviceName? }
  parseCredentialId,
} from "../domain/auth";
import { fromBase64Url, toBase64Url, utf8Bytes } from "../lib/base64url";
import { consumeChallenge, issueChallenge } from "../middleware/challenge-cookie";
import { authRateLimit } from "../middleware/rate-limit";
import { issueSession, revokeSession, sessionMiddleware } from "../middleware/session";
import type { Env } from "../types";
// Provided by cloudflare-workers-space-membership-invite (worker/spaces/registration.ts). All three take the
// RAW `c.env.DB` binding, not a Drizzle instance: the batches need prepare/bind/batch + `meta.changes`.
//   validateInvite(c.env.DB, token) -> Result<{ id, spaceId }, AuthError>   (403 invite_invalid / 410 invite_consumed / 410 invite_expired)
//   registerInvitedUser(c.env.DB, state, user, cred)  -> Result<void, AuthError> (users + space_members + credentials + invites UPDATE in one batch)
//   registerInitialUser(c.env.DB, user, cred)         -> users + spaces + space_members(owner) + credentials in one batch
import { registerInitialUser, registerInvitedUser, validateInvite } from "../spaces/registration";

function fail(c: Context<Env>, error: AuthError) {
  const { body, status } = authErrorResponse(error);
  return c.json(body, status);
}

const registrationOptionsFor = (env: Env["Bindings"], userId: string, displayName: string) =>
  generateRegistrationOptions({
    rpName: env.RP_NAME ?? "app",
    rpID: env.RP_ID,
    userID: utf8Bytes(userId),
    userName: displayName,
    userDisplayName: displayName,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });

export const authRoutes = new Hono<Env>()
  // ---------------------------------------------------------------- register (PUBLIC)
  .post("/register/begin", authRateLimit, async (c) => {
    const parsed = parseBeginRegistration(await c.req.json().catch(() => ({})));
    if (parsed.isErr()) return fail(c, parsed.error);
    const { displayName, initialRegistrationToken, inviteToken } = parsed.value;
    const pendingUserId = crypto.randomUUID();

    let state: Parameters<typeof issueChallenge>[2];
    if (inviteToken !== undefined) {
      // Path: invite. Token validity, consumption and the target space are the sibling skill's.
      const invite = await validateInvite(c.env.DB, inviteToken);
      if (invite.isErr()) return fail(c, invite.error);
      state = {
        kind: "invite",
        uid: pendingUserId,
        displayName,
        inviteId: invite.value.id,
        spaceId: invite.value.spaceId,
      };
    } else {
      // Path: initial. An unset secret closes registration entirely (also covers the
      // deploy-then-race window). Optional hardening: crypto.subtle.timingSafeEqual.
      const secret = c.env.INITIAL_REGISTRATION_TOKEN;
      if (!secret || initialRegistrationToken !== secret) {
        return fail(c, { type: "registration_closed", message: "Registration is closed" });
      }
      state = { kind: "initial", uid: pendingUserId, displayName };
    }

    const options = await registrationOptionsFor(c.env, pendingUserId, displayName);
    await issueChallenge(c, options.challenge, state);
    return c.json({ options });
  })
  .post("/register/verify", authRateLimit, async (c) => {
    const parsed = parseVerifyRegistration(await c.req.json());
    if (parsed.isErr()) return fail(c, parsed.error);

    const ch = await consumeChallenge(c);
    if (!ch || (ch.state.kind !== "initial" && ch.state.kind !== "invite")) {
      return fail(c, { type: "challenge_mismatch", message: "No registration challenge" });
    }

    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response: parsed.value.response as RegistrationResponseJSON,
        expectedChallenge: ch.challenge,
        expectedOrigin: c.env.ORIGIN, // byte-for-byte the browser origin, incl. port
        expectedRPID: c.env.RP_ID,
        requireUserVerification: false,
      });
    } catch (e) {
      return fail(c, {
        type: "challenge_mismatch",
        message: e instanceof Error ? e.message : "verification failed",
      });
    }
    if (!verification.verified || !verification.registrationInfo) {
      return fail(c, { type: "challenge_mismatch", message: "Registration not verified" });
    }

    const { credential, credentialBackedUp } = verification.registrationInfo;
    const now = new Date().toISOString();
    const user = { id: ch.state.uid, displayName: ch.state.displayName, createdAt: now };
    const cred: NewCredential = {
      id: credential.id,
      userId: ch.state.uid,
      publicKey: toBase64Url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ? JSON.stringify(credential.transports) : null,
      deviceName: parsed.value.deviceName ?? null,
      backedUp: credentialBackedUp,
      createdAt: now,
      lastUsedAt: now,
    };

    if (ch.state.kind === "initial") {
      // Without spaces this is just:
      //   const db = drizzle(c.env.DB); await db.batch([db.insert(users).values(user), db.insert(credentials).values(cred)]);
      await registerInitialUser(c.env.DB, user, cred);
    } else {
      const r = await registerInvitedUser(c.env.DB, ch.state, user, cred);
      if (r.isErr()) return fail(c, r.error); // 409 invite_race etc.
    }

    await issueSession(c, UserId.parse(user.id));
    return c.json({ id: user.id, displayName: user.displayName }, 201);
  })
  // ---------------------------------------------------------------- login (PUBLIC)
  .post("/login/begin", authRateLimit, async (c) => {
    // No allowCredentials -> discoverable-credential (passkey picker) flow, no username field.
    const options = await generateAuthenticationOptions({
      rpID: c.env.RP_ID,
      userVerification: "preferred",
    });
    await issueChallenge(c, options.challenge, { kind: "authentication" });
    return c.json({ options });
  })
  .post("/login/verify", authRateLimit, async (c) => {
    const parsed = parseVerifyLogin(await c.req.json());
    if (parsed.isErr()) return fail(c, parsed.error);
    const ch = await consumeChallenge(c);
    if (!ch || ch.state.kind !== "authentication") {
      return fail(c, { type: "challenge_mismatch", message: "No authentication challenge" });
    }

    const response = parsed.value.response as AuthenticationResponseJSON;
    const db = drizzle(c.env.DB);
    const rows = await db.select().from(credentials).where(eq(credentials.id, response.id));
    const row = rows[0];
    if (!row) return fail(c, { type: "not_found", message: "Credential not registered" });

    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: ch.challenge,
        expectedOrigin: c.env.ORIGIN,
        expectedRPID: c.env.RP_ID,
        credential: {
          id: row.id,
          publicKey: fromBase64Url(row.publicKey),
          counter: row.counter,
          transports: row.transports
            ? (JSON.parse(row.transports) as AuthenticatorTransportFuture[])
            : undefined,
        },
        requireUserVerification: false,
      });
    } catch (e) {
      return fail(c, {
        type: "challenge_mismatch",
        message: e instanceof Error ? e.message : "verification failed",
      });
    }
    if (!verification.verified) {
      return fail(c, { type: "challenge_mismatch", message: "Authentication not verified" });
    }

    // Counter regression guard. Synced passkeys (iCloud Keychain, Google Password Manager)
    // report 0 forever — a strict `<=` without the `!== 0` exemption locks out every iPhone.
    // (@simplewebauthn applies the same rule internally; this is belt-and-braces.)
    const newCounter = verification.authenticationInfo.newCounter;
    if (row.counter !== 0 && newCounter <= row.counter) {
      return fail(c, { type: "unauthorized", message: "Authenticator counter regression" });
    }

    await db
      .update(credentials)
      .set({ counter: newCounter, lastUsedAt: new Date().toISOString() })
      .where(eq(credentials.id, row.id));

    await issueSession(c, UserId.parse(row.userId));
    const u = (await db.select().from(users).where(eq(users.id, row.userId)))[0];
    return c.json({ id: u.id, displayName: u.displayName });
  })
  // ---------------------------------------------------------------- session-only routes
  .post("/logout", sessionMiddleware(), async (c) => {
    await revokeSession(c);
    return c.json({});
  })
  .get("/me", sessionMiddleware(), (c) => {
    return c.json({ id: c.get("userId"), displayName: c.get("displayName") });
  })
  .get("/credentials", sessionMiddleware(), async (c) => {
    const db = drizzle(c.env.DB);
    const rows = await db
      .select({
        id: credentials.id,
        deviceName: credentials.deviceName,
        backedUp: credentials.backedUp,
        createdAt: credentials.createdAt,
        lastUsedAt: credentials.lastUsedAt,
      })
      .from(credentials)
      .where(eq(credentials.userId, c.get("userId")));
    return c.json(rows);
  })
  .post("/credentials/add/begin", sessionMiddleware(), async (c) => {
    const parsed = parseAddCredentialBegin(await c.req.json().catch(() => ({})));
    if (parsed.isErr()) return fail(c, parsed.error);
    const userId = c.get("userId");
    const db = drizzle(c.env.DB);
    const existing = await db
      .select({ id: credentials.id, transports: credentials.transports })
      .from(credentials)
      .where(eq(credentials.userId, userId));

    const options = await generateRegistrationOptions({
      rpName: c.env.RP_NAME ?? "app",
      rpID: c.env.RP_ID,
      userID: utf8Bytes(userId),
      userName: c.get("displayName"),
      userDisplayName: c.get("displayName"),
      attestationType: "none",
      // Authenticators that already hold a passkey for this user refuse with InvalidStateError
      // instead of silently creating a duplicate.
      excludeCredentials: existing.map((e) => ({
        id: e.id,
        transports: e.transports
          ? (JSON.parse(e.transports) as AuthenticatorTransportFuture[])
          : undefined,
      })),
      authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
    });
    await issueChallenge(c, options.challenge, { kind: "add-credential", uid: userId });
    return c.json({ options });
  })
  .post("/credentials/add/verify", sessionMiddleware(), async (c) => {
    const parsed = parseAddCredentialVerify(await c.req.json());
    if (parsed.isErr()) return fail(c, parsed.error);
    const ch = await consumeChallenge(c);
    if (!ch || ch.state.kind !== "add-credential" || ch.state.uid !== c.get("userId")) {
      return fail(c, { type: "challenge_mismatch", message: "No add-credential challenge" });
    }
    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response: parsed.value.response as RegistrationResponseJSON,
        expectedChallenge: ch.challenge,
        expectedOrigin: c.env.ORIGIN,
        expectedRPID: c.env.RP_ID,
        requireUserVerification: false,
      });
    } catch (e) {
      return fail(c, {
        type: "challenge_mismatch",
        message: e instanceof Error ? e.message : "verification failed",
      });
    }
    if (!verification.verified || !verification.registrationInfo) {
      return fail(c, { type: "challenge_mismatch", message: "Registration not verified" });
    }
    const { credential, credentialBackedUp } = verification.registrationInfo;
    const now = new Date().toISOString();
    await drizzle(c.env.DB)
      .insert(credentials)
      .values({
        id: credential.id,
        userId: c.get("userId"),
        publicKey: toBase64Url(credential.publicKey),
        counter: credential.counter,
        transports: credential.transports ? JSON.stringify(credential.transports) : null,
        deviceName: parsed.value.deviceName ?? null,
        backedUp: credentialBackedUp,
        createdAt: now,
        lastUsedAt: null,
      });
    return c.json({ id: credential.id }, 201);
  })
  .delete("/credentials/:id", sessionMiddleware(), async (c) => {
    const id = parseCredentialId(c.req.param("id"));
    if (id.isErr()) return fail(c, id.error);
    const userId = c.get("userId");
    const db = drizzle(c.env.DB);
    // Last-credential guard: without a passkey the account is unrecoverable without an operator.
    const [{ n }] = await db
      .select({ n: count() })
      .from(credentials)
      .where(eq(credentials.userId, userId));
    if (n <= 1) {
      return fail(c, { type: "last_credential", message: "Cannot delete the last passkey" });
    }
    const deleted = await db
      .delete(credentials)
      .where(and(eq(credentials.id, id.value), eq(credentials.userId, userId)))
      .returning({ id: credentials.id });
    if (deleted.length === 0) return fail(c, { type: "not_found", message: "Credential not found" });
    return c.json({});
  });
```

`authErrorResponse` maps `AuthError.type` → status: `validation_error` 400, `challenge_mismatch` 400, `registration_closed` 403, `unauthorized` 401, `session_expired` 401, `not_found` 404, `last_credential` 400, plus the sibling skill's `invite_invalid` 403 / `invite_consumed` 410 / `invite_expired` 410 / `invite_race` 409.

Notes:
- `register/verify` **does not re-validate** the invite token: the signed challenge cookie already carries `inviteId`/`spaceId`, and the sibling skill's batch re-checks `consumed_at IS NULL` atomically at consumption time.
- `credential.publicKey` / `userID` handle types: see `utf8Bytes` above (TS ≥ 5.7 trap).

## `worker/index.ts` (mount order matters)

```typescript
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { csrfOriginCheck } from "./middleware/csrf";
import { sessionMiddleware } from "./middleware/session";
import { authRoutes } from "./routes/auth";
import type { Env } from "./types";

const app = new Hono<Env>();

app.use("*", secureHeaders({ /* per cloudflare-workers-deploy-skeleton / bot-scan-defense */ }));
app.onError((err, c) => {
  console.error(err);
  return c.json({ error: { type: "internal" } }, 500);
});
app.get("/health", (c) => c.json({ status: "ok" }));

const api = new Hono<Env>();
api.use("*", csrfOriginCheck);

// 1. PUBLIC subset first. authRoutes applies sessionMiddleware() per route where needed.
api.route("/auth", authRoutes);

// 2. Everything else behind the session. `/*` also matches /auth/*, but the public handler
//    registered above already answered — swap 1 and 2 and login/begin returns 401.
const protectedApi = new Hono<Env>();
protectedApi.use("/*", sessionMiddleware());
// protectedApi.route("/spaces", spaceRoutes);   // sibling skill
// protectedApi.route("/meals", mealRoutes);     // your domain
api.route("/", protectedApi);

app.route("/api", api);

// SPA fallback (3-layer routing dance from cloudflare-workers-deploy-skeleton)
app.notFound(async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  return new Response(res.body, res);
});

export type AppType = typeof app;
export default app;
```
