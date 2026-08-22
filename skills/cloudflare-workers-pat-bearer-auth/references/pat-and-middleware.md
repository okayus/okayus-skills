# PAT validation and the auth middleware

From mazuoboeru `apps/web/worker/auth/{scopes,pat,middleware}.ts`, `worker/types.ts`, `worker/http/errors.ts`. Drop-in for a Hono 4 + Drizzle + D1 Worker whose session layer exposes a `getSessionUser(c)`; the passkey-session variant is at the end.

## `worker/auth/scopes.ts` — the vocabulary

```ts
// PAT scope vocabulary — the single source of truth. A const tuple (not a bare
// string[]) so the `Scope` union is derived from it: requireScope() args and token
// grants are checked at compile time, and a typo like "quiz:wrte" fails to compile
// instead of silently denying a valid PAT.
// Sessions are NOT scope-limited (scopes = [] means full access — see middleware).
export const SCOPES = ["quiz:read", "quiz:write"] as const; // e.g. kokemusu: ["post:read", "post:write"]
export type Scope = (typeof SCOPES)[number];

export function isScope(s: string): s is Scope {
  return (SCOPES as readonly string[]).includes(s);
}
```

Naming: `<resource>:<read|write>`. Renaming a scope is a **data migration** (`UPDATE api_token SET scopes = replace(scopes, '"old"', '"new"')`) — otherwise `parseScopes` drops the old name and every token silently loses it.

## `worker/auth/pat.ts` — mint, list, revoke, validate

```ts
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { apiToken, user, type User } from "../db/schema";
import { randomToken, sha256Hex } from "../lib/crypto";
import { newId } from "../lib/id";
import { parseStringArray } from "../lib/json";
import { isScope, SCOPES, type Scope } from "./scopes";
import type { Bindings } from "../types";

// The `<app>_pat_` prefix makes tokens identifiable in logs / dumps / grep and lets
// validatePat reject non-tokens before hashing. It is NOT a secret-scanning guarantee
// (GitHub's free push protection knows only its built-in supported patterns) — see SKILL.md.
const PAT_PREFIX = "app_pat_"; // ← your app's prefix, e.g. "mzo_pat_"
const LAST_USED_THROTTLE_MS = 60 * 60 * 1000; // update last_used_at at most hourly

function generatePat(): string {
  return PAT_PREFIX + randomToken(32);
}

// token_hash = sha256(token + pepper). The pepper is a Worker Secret, never stored
// with the hash. An unset pepper (local dev) hashes the bare token.
function hashPat(env: Bindings, token: string): Promise<string> {
  return sha256Hex(token + (env.PAT_PEPPER ?? ""));
}

export type CreatedToken = {
  id: string;
  name: string;
  token: string; // raw — returned exactly once, by POST /api/tokens
  scopes: Scope[];
  createdAt: number;
};

export async function createToken(
  env: Bindings,
  userId: string,
  name: string,
): Promise<CreatedToken> {
  const token = generatePat();
  const tokenHash = await hashPat(env, token);
  const id = newId();
  const now = Date.now();
  const scopes: Scope[] = [...SCOPES]; // MVP: every token gets the full set (no picker yet)
  await db(env)
    .insert(apiToken)
    .values({ id, userId, name, tokenHash, scopes: JSON.stringify(scopes), createdAt: now });
  return { id, name, token, scopes, createdAt: now };
}

export type TokenSummary = {
  id: string;
  name: string;
  scopes: Scope[];
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
};

// Never selects token_hash.
export async function listTokens(env: Bindings, userId: string): Promise<TokenSummary[]> {
  const rows = await db(env)
    .select({
      id: apiToken.id,
      name: apiToken.name,
      scopes: apiToken.scopes,
      createdAt: apiToken.createdAt,
      lastUsedAt: apiToken.lastUsedAt,
      expiresAt: apiToken.expiresAt,
      revokedAt: apiToken.revokedAt,
    })
    .from(apiToken)
    .where(eq(apiToken.userId, userId))
    .orderBy(desc(apiToken.createdAt));
  return rows.map((r) => ({ ...r, scopes: parseScopes(r.scopes) }));
}

// Revoke a token the caller owns. Returns false if it isn't theirs / doesn't exist
// (the route answers 404 either way — no existence leak).
export async function revokeToken(env: Bindings, userId: string, id: string): Promise<boolean> {
  const owned = await db(env)
    .select({ id: apiToken.id })
    .from(apiToken)
    .where(and(eq(apiToken.id, id), eq(apiToken.userId, userId)))
    .limit(1);
  if (!owned[0]) return false;
  await db(env).update(apiToken).set({ revokedAt: Date.now() }).where(eq(apiToken.id, id));
  return true;
}

export type PatPrincipal = { user: User; scopes: Scope[] };

// Validate a Bearer PAT. Returns the principal (user + scopes) or null. Cheap
// rejects first (no scheme / no prefix → no hash, no D1). Touches last_used_at at
// most hourly. Called by the auth middleware BEFORE the session lookup.
export async function validatePat(
  env: Bindings,
  authorization: string | undefined,
): Promise<PatPrincipal | null> {
  if (!authorization?.startsWith("Bearer ")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  if (!token.startsWith(PAT_PREFIX)) return null;

  const tokenHash = await hashPat(env, token);
  const rows = await db(env)
    .select({ user, token: apiToken })
    .from(apiToken)
    .innerJoin(user, eq(apiToken.userId, user.id))
    .where(eq(apiToken.tokenHash, tokenHash))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const t = row.token;
  const now = Date.now();
  if (t.revokedAt !== null) return null;
  if (t.expiresAt !== null && t.expiresAt < now) return null;
  // If your users table has a status column, reject suspended accounts here so a PAT
  // dies with the account. (mazuoboeru has `user.status` but does not check it yet.)

  if (t.lastUsedAt === null || now - t.lastUsedAt > LAST_USED_THROTTLE_MS) {
    await db(env).update(apiToken).set({ lastUsedAt: now }).where(eq(apiToken.id, t.id));
  }
  return { user: row.user, scopes: parseScopes(t.scopes) };
}

// Stored scopes → typed Scope[]; any unknown/legacy scope string is dropped.
function parseScopes(json: string): Scope[] {
  return parseStringArray(json).filter(isScope);
}
```

Notes:

- Returning `null` for "revoked" and "expired" (not a distinct error) is deliberate: the caller gets a plain `401 unauthorized`, and the UI's token list is where the *user* learns why. Distinguishing them on the wire only helps an attacker confirm a token was real.
- `.limit(1)` + the `UNIQUE` index = one point read. The `innerJoin` with `user` is what lets a dangling row fall out as `null`.

## `worker/auth/middleware.ts` — PAT first, then the session

```ts
import type { Context, MiddlewareHandler } from "hono";
import type { User } from "../db/schema";
import type { AuthMethod, Env } from "../types";
import { apiError } from "../http/errors";
import { validatePat } from "./pat";
import type { Scope } from "./scopes";
import { getSessionUser } from "./session"; // your cookie-session lookup (OAuth or passkey)

type Resolved = { user: User; method: AuthMethod; scopes: Scope[] };

// Resolve the user for a request. A Bearer PAT takes precedence over the session
// cookie; returns null if unauthenticated. Sessions get full access (scopes = []
// means "not scope-limited"); PATs carry their granted scopes.
async function authenticate(c: Context<Env>): Promise<Resolved | null> {
  const pat = await validatePat(c.env, c.req.header("Authorization"));
  if (pat) return { user: pat.user, method: "pat", scopes: pat.scopes };
  const sessionUser = await getSessionUser(c);
  if (sessionUser) return { user: sessionUser, method: "session", scopes: [] };
  return null;
}

function apply(c: Context<Env>, auth: Resolved): void {
  c.set("user", auth.user);
  c.set("authMethod", auth.method);
  c.set("scopes", auth.scopes);
}

// Populate c.user when authenticated, but never reject. For public routes that
// behave differently when logged in (e.g. the timeline).
export const optionalAuth: MiddlewareHandler<Env> = async (c, next) => {
  const auth = await authenticate(c);
  if (auth) apply(c, auth);
  await next();
};

// Reject with 401 unless authenticated (session or PAT). Safe to stack after
// optionalAuth (reuses the resolved user) or to use standalone.
export const requireAuth: MiddlewareHandler<Env> = async (c, next) => {
  let user = c.get("user");
  if (!user) {
    const auth = await authenticate(c);
    if (auth) {
      apply(c, auth);
      user = auth.user;
    }
  }
  if (!user) return c.json(apiError("unauthorized"), 401);
  await next();
};

// Require a *cookie session* specifically — not a PAT. Used for sensitive account
// operations like minting/revoking PATs (a PAT must not be able to mint more PATs).
export const requireSession: MiddlewareHandler<Env> = async (c, next) => {
  let user = c.get("user");
  if (!user) {
    const auth = await authenticate(c);
    if (auth) {
      apply(c, auth);
      user = auth.user;
    }
  }
  if (!user) return c.json(apiError("unauthorized"), 401);
  if (c.get("authMethod") !== "session") {
    return c.json(apiError("session_required"), 403);
  }
  await next();
};

// Require a PAT scope. Sessions (scopes resolved as full access) always pass.
// NOT an authentication check: stack it AFTER requireAuth.
export function requireScope(scope: Scope): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (c.get("authMethod") === "pat") {
      const scopes = c.get("scopes") ?? [];
      if (!scopes.includes(scope)) {
        return c.json(apiError("insufficient_scope", { scope }), 403);
      }
    }
    await next();
  };
}

// Read the authenticated user after requireAuth. Throws if misused (no auth ran).
export function requireUser(c: Context<Env>): User {
  const user = c.get("user");
  if (!user) throw new Error("requireUser called without requireAuth");
  return user;
}
```

Usage on a route:

```ts
export const quizzesRouter = new Hono<Env>()
  .get("/mine", requireAuth, requireScope("quiz:read"), async (c) => {
    /* … */
  })
  .post("/", requireAuth, requireScope("quiz:write"), async (c) => {
    /* … */
  });
```

`optionalAuth` runs once on the `/api` group (see the routes reference), so `requireAuth` normally finds `c.get("user")` already set and does no second lookup.

## `worker/types.ts` additions

```ts
export type AuthMethod = "session" | "pat";

// Hono context variables. `user` is set by the auth middleware when a request is
// authenticated; read it via requireUser(c) after requireAuth, never assume it.
// `scopes` is populated for PAT-authenticated requests (sessions have full access).
export type Variables = {
  user?: User;
  authMethod?: AuthMethod;
  scopes?: Scope[];
};

export type Env = { Bindings: Bindings; Variables: Variables };
```

## `worker/http/errors.ts` — codes this skill needs

Add to your closed `API_ERROR_CODES` tuple: `"unauthorized"`, `"session_required"`, `"insufficient_scope"`, `"csrf_origin_mismatch"`, `"invalid_body"`, `"not_found"`. Bodies are `{ error: code }` plus optional detail (`insufficient_scope` adds `{ scope }`).

## Variant: composing with a passkey session (UNVERIFIED — kokemusu is the first)

`cloudflare-workers-passkey-auth` doesn't expose a `getSessionUser`; its `sessionMiddleware()` does the JWT → `sessions` row → `c.set("userId") / c.set("displayName")` dance inline and rejects on failure. To put a PAT in front of it without duplicating the cookie logic:

1. Extract the cookie lookup from that middleware into `resolveSessionUser(c): Promise<{ userId, displayName } | null>` (same queries, no response writing — the sliding-expiry write stays inside it).
2. Make `authenticate` return `{ userId, displayName, method, scopes }`; `validatePat` selects `{ id, displayName }` from `users` instead of the full row.
3. `apply` sets `userId`, `displayName`, `authMethod`, `scopes` — the passkey skill's `Variables` plus the two from this skill. Every domain handler keeps reading `c.var.userId`.
4. `sessionMiddleware()` becomes `requireAuth`; the passkey skill's dev-bypass twin guard moves into `resolveSessionUser` (a bypass must never be reachable through the PAT path).
5. `/api/auth/credentials/*` (add / delete a device) goes behind `requireSession`, like `/api/tokens/*` — credentials are managed by humans with a cookie, not by tokens.
6. Port the Bearer exemption into the passkey skill's `csrfOriginCheck` (the `isBearer` skip shown in `routes-and-client.md`), keeping that skill's `{ error: { type: "csrf_origin_mismatch" } }` body shape. Without it every PAT mutation is this skill's symptom #1 — `403 csrf_origin_mismatch`.

Write the final `Variables` shape back here once it runs.
