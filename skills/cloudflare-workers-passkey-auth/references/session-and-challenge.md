# Session + challenge: types, cookie helpers, middleware

Four files. All cookie attributes are derived from `ORIGIN`; nothing is hardcoded `secure: true`.

## `worker/types.ts`

```typescript
import type { DisplayName, UserId } from "./domain/auth";

// D1Database / Fetcher / RateLimit are globals from `wrangler types` (worker-configuration.d.ts);
// no import from @cloudflare/workers-types.
export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  AUTH_RATE_LIMITER: RateLimit;
  SESSION_SECRET: string; // openssl rand -hex 32 ; signs the session JWT AND the challenge cookie
  RP_ID: string; //  hostname only, e.g. "app.<your-subdomain>.workers.dev" — permanent (see SKILL.md)
  ORIGIN: string; //  "https://app.<your-subdomain>.workers.dev" — must equal the browser origin
  RP_NAME?: string; // human-readable name shown by the authenticator UI
  INITIAL_REGISTRATION_TOKEN?: string; // set only while bootstrapping the first user
  DEV_BYPASS_USER_ID?: string; // .dev.vars only. Honored only on a localhost ORIGIN.
};

type Variables = {
  userId: UserId;
  displayName: DisplayName;
  // memberSpaceIds: SpaceId[]  ← added by cloudflare-workers-space-membership-invite
};

export type Env = { Bindings: Bindings; Variables: Variables };
```

`UserId` / `DisplayName` are zod-branded strings (`z.string().uuid().transform(v => v as UserId)`), as in nyalog's `domain/auth.ts`. Plain `string` works too; the brand just keeps a `spaceId` from being passed where a `userId` is expected.

## `worker/lib/cookies.ts`

```typescript
import type { Context } from "hono";
import type { Env } from "../types";

export function isHttps(c: Context<Env>): boolean {
  return c.env.ORIGIN.startsWith("https://");
}

// Host-only on purpose: no `domain` key anywhere. Sibling Workers share
// <account>.workers.dev, and a Domain= cookie would be visible to all of them.
// `__Host-` makes the browser enforce Secure + Path=/ + no Domain; it is rejected over
// plain http, so local dev / e2e (http://localhost, http://127.0.0.1) use a bare name.
export function sessionCookieName(c: Context<Env>): string {
  return isHttps(c) ? "__Host-session" : "session";
}

export function challengeCookieName(c: Context<Env>): string {
  return isHttps(c) ? "__Host-challenge" : "challenge";
}

export function cookieBase(c: Context<Env>) {
  return { httpOnly: true, secure: isHttps(c), sameSite: "Lax" as const, path: "/" };
}
```

## `worker/middleware/challenge-cookie.ts`

The WebAuthn challenge and the registration state travel in a signed, short-lived cookie. No D1 table, no cleanup job, single use.

```typescript
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sign, verify } from "hono/jwt";
import { challengeCookieName, cookieBase } from "../lib/cookies";
import type { Env } from "../types";

const TTL_SEC = 5 * 60;
// Distinct audience from the session JWT: a session token can never be replayed as a challenge.
const AUD = "app:challenge";

// Everything `verify` needs is signed here. Nothing about ids comes from the client.
export type ChallengeState =
  | { kind: "authentication" }
  | { kind: "add-credential"; uid: string }
  | { kind: "initial"; uid: string; displayName: string }
  | { kind: "invite"; uid: string; displayName: string; inviteId: string; spaceId: string };

type Payload = { challenge: string; state: ChallengeState; aud: typeof AUD; exp: number };

export async function issueChallenge(
  c: Context<Env>,
  challenge: string,
  state: ChallengeState,
): Promise<void> {
  const token = await sign(
    { challenge, state, aud: AUD, exp: Math.floor(Date.now() / 1000) + TTL_SEC } satisfies Payload,
    c.env.SESSION_SECRET,
  );
  setCookie(c, challengeCookieName(c), token, { ...cookieBase(c), maxAge: TTL_SEC });
}

// Single use: the cookie is deleted before it is validated, so a failed verify cannot be retried
// against the same challenge. Callers narrow `state.kind` themselves.
export async function consumeChallenge(
  c: Context<Env>,
): Promise<{ challenge: string; state: ChallengeState } | null> {
  const name = challengeCookieName(c);
  const token = getCookie(c, name);
  deleteCookie(c, name, { path: "/" });
  if (!token) return null;
  try {
    // hono/jwt verify checks the signature and `exp` (UNVERIFIED in SKILL.md — unit-test it).
    const p = (await verify(token, c.env.SESSION_SECRET, "HS256")) as Payload;
    if (p.aud !== AUD) return null;
    return { challenge: p.challenge, state: p.state };
  } catch {
    return null;
  }
}
```

Size: the largest state (`invite`) is ~5 short strings; the signed cookie stays well under 1 KB.

## `worker/middleware/session.ts`

```typescript
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { sign, verify } from "hono/jwt";
import { sessions, users } from "../db/schema";
import { DisplayName, UserId } from "../domain/auth";
import { cookieBase, sessionCookieName } from "../lib/cookies";
import type { Env } from "../types";

const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const AUD = "app:session";

type SessionPayload = { sid: string; aud: typeof AUD; exp: number };

async function writeSessionCookie(c: Context<Env>, sid: string, expiresAt: Date): Promise<void> {
  const token = await sign(
    { sid, aud: AUD, exp: Math.floor(expiresAt.getTime() / 1000) } satisfies SessionPayload,
    c.env.SESSION_SECRET,
  );
  setCookie(c, sessionCookieName(c), token, {
    ...cookieBase(c),
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

function unauthorized(c: Context<Env>, type: string, message?: string) {
  return c.json({ error: { type, ...(message ? { message } : {}) } }, 401);
}

// Called by register/verify, login/verify, credentials/add/verify.
export async function issueSession(c: Context<Env>, userId: UserId): Promise<void> {
  const db = drizzle(c.env.DB);
  const sid = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MS);
  await db.insert(sessions).values({
    id: sid,
    userId,
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
  });
  await writeSessionCookie(c, sid, expiresAt);
}

// Logout: the row is the source of truth, so deleting it kills the JWT immediately.
export async function revokeSession(c: Context<Env>): Promise<void> {
  const name = sessionCookieName(c);
  const token = getCookie(c, name);
  if (token) {
    try {
      const payload = (await verify(token, c.env.SESSION_SECRET, "HS256")) as SessionPayload;
      if (payload.aud === AUD) {
        await drizzle(c.env.DB).delete(sessions).where(eq(sessions.id, payload.sid));
      }
    } catch {
      // invalid token: nothing to revoke
    }
  }
  deleteCookie(c, name, { path: "/" });
}

function isLocalOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

export function sessionMiddleware() {
  return createMiddleware<Env>(async (c, next) => {
    // ---- dev bypass: twin guard (value set AND local origin) ----
    if (c.env.DEV_BYPASS_USER_ID && isLocalOrigin(c.env.ORIGIN)) {
      const db = drizzle(c.env.DB);
      const devId = c.env.DEV_BYPASS_USER_ID;
      const now = new Date().toISOString();
      await db
        .insert(users)
        .values({ id: devId, displayName: "dev", createdAt: now })
        .onConflictDoNothing();
      // With spaces: also upsert a fixed dev space + membership here so memberSpaceIds is
      // non-empty (cloudflare-workers-space-membership-invite).
      c.set("userId", UserId.parse(devId));
      c.set("displayName", DisplayName.parse("dev"));
      await next();
      return;
    }
    if (c.env.DEV_BYPASS_USER_ID) {
      console.error("DEV_BYPASS_USER_ID is set on a non-local ORIGIN; ignoring for safety");
    }

    // ---- real path ----
    const name = sessionCookieName(c);
    const token = getCookie(c, name);
    if (!token) return unauthorized(c, "unauthorized", "No session");

    let payload: SessionPayload;
    try {
      payload = (await verify(token, c.env.SESSION_SECRET, "HS256")) as SessionPayload;
    } catch {
      return unauthorized(c, "unauthorized", "Invalid session token");
    }
    if (payload.aud !== AUD) return unauthorized(c, "unauthorized", "Wrong token audience");

    const db = drizzle(c.env.DB);
    const rows = await db
      .select({
        sid: sessions.id,
        expiresAt: sessions.expiresAt,
        userId: sessions.userId,
        displayName: users.displayName,
      })
      .from(sessions)
      .innerJoin(users, eq(sessions.userId, users.id))
      .where(eq(sessions.id, payload.sid));
    const row = rows[0];
    if (!row) {
      deleteCookie(c, name, { path: "/" });
      return unauthorized(c, "session_expired");
    }
    const expiresMs = new Date(row.expiresAt).getTime();
    if (expiresMs < Date.now()) {
      await db.delete(sessions).where(eq(sessions.id, row.sid));
      deleteCookie(c, name, { path: "/" });
      return unauthorized(c, "session_expired");
    }

    c.set("userId", UserId.parse(row.userId));
    c.set("displayName", DisplayName.parse(row.displayName));
    // With spaces: c.set("memberSpaceIds", await loadMemberSpaceIds(db, userId)) — sibling skill.

    // Sliding expiry: one write per ~15 days per active session.
    // (mazuoboeru's variant: refresh whenever lastSeenAt is older than a day.)
    if (expiresMs - Date.now() < SESSION_MS / 2) {
      const newExpires = new Date(Date.now() + SESSION_MS);
      await db
        .update(sessions)
        .set({ expiresAt: newExpires.toISOString() })
        .where(eq(sessions.id, row.sid));
      await writeSessionCookie(c, row.sid, newExpires);
    }

    await next();
  });
}
```

### Behaviour summary

| Situation | Response | Side effect |
|---|---|---|
| No cookie | `401 unauthorized` | — |
| Bad signature / wrong `aud` / expired JWT | `401 unauthorized` | — |
| Valid JWT, no `sessions` row (logged out elsewhere, secret rotated then rows cleared) | `401 session_expired` | cookie cleared |
| Row expired | `401 session_expired` | row deleted, cookie cleared |
| Valid, < 15 days left | `200` | row + cookie extended to now + 30 d |

The SPA treats any `401` as "show the login screen"; `session_expired` vs `unauthorized` is only for logs.

### Alternatives that are equally fine

- `jose` (`SignJWT` / `jwtVerify`, claims `sub` + `jti`) instead of `hono/jwt` — routine-tasks does this. Same shape, one more dependency.
- Storing `sha256(randomToken)` as `sessions.id` with the raw token in the cookie (mazuoboeru) instead of a JWT — no signature step, and a DB leak cannot be replayed. Pick it if you don't want JWTs at all; the middleware is the same minus `verify`.
