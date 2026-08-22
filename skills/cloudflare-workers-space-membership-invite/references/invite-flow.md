# Invite flow: issue, validate, consume (race-safe), client handling

Plain token → only in the issue response and the link. DB → `sha256` hex only. Consumption → one `env.DB.batch()` whose **last** statement is `UPDATE invites … WHERE consumed_at IS NULL`, with `meta.changes` asserted. The passkey skill's `register/begin` / `register/verify` call the three functions in `worker/spaces/registration.ts` below and never touch the token logic themselves.

## Token helpers

```ts
// worker/lib/token.ts — Workers Web Crypto only, no imports
export function randomTokenHex(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
```

## `worker/spaces/registration.ts` — the contract with `cloudflare-workers-passkey-auth`

Exactly three exports, neverthrow `Result`s. They take the **raw `D1Database` binding** (`c.env.DB`) because the batches need `prepare` / `bind` / `batch` and per-statement `meta.changes`; a Drizzle instance is created internally for reads. (If the caller only has a Drizzle instance, `db.$client` is the binding on drizzle-orm ≥ 0.34 — UNVERIFIED; passing `c.env.DB` avoids the question.) Import paths for `AuthError`, `NewCredential` and `ChallengeState` follow wherever the passkey skill put them.

```ts
// worker/spaces/registration.ts
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { err, ok, type Result } from "neverthrow";
import { invites } from "../db/schema";
import type { AuthError } from "../domain/auth";                         // passkey skill
import type { NewCredential } from "../db/schema";                         // passkey skill (typeof credentials.$inferInsert)
import type { ChallengeState } from "../middleware/challenge-cookie";   // passkey skill
import { sha256Hex } from "../lib/token";

export type InviteState = Extract<ChallengeState, { kind: "invite" }>;
export type NewUser = { id: string; displayName: string; createdAt: string };

// register/begin (and POST /api/invites/accept): is this token usable right now?
export async function validateInvite(
  d1: D1Database,
  token: string,
): Promise<Result<{ id: string; spaceId: string }, AuthError>> {
  if (!/^[0-9a-f]{64}$/.test(token)) return err({ type: "invite_invalid", message: "Unknown invite" });
  const db = drizzle(d1);
  const rows = await db.select().from(invites).where(eq(invites.tokenHash, await sha256Hex(token)));
  const inv = rows[0];
  if (!inv) return err({ type: "invite_invalid", message: "Unknown invite" });
  if (inv.consumedAt) return err({ type: "invite_consumed", message: "Invite already used" }); // before expiry
  if (new Date(inv.expiresAt) <= new Date()) return err({ type: "invite_expired", message: "Invite expired" });
  return ok({ id: inv.id, spaceId: inv.spaceId });
}

// register/verify, INITIAL_REGISTRATION_TOKEN path: owner + first space + passkey, atomically.
// The session row is NOT here — the passkey skill's issueSession() adds it afterwards.
export async function registerInitialUser(
  d1: D1Database,
  user: NewUser,
  cred: NewCredential,
): Promise<void> {
  const spaceId = crypto.randomUUID();
  await d1.batch([
    d1.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)")
      .bind(user.id, user.displayName, user.createdAt),
    d1.prepare("INSERT INTO spaces (id, name, created_at) VALUES (?, ?, ?)")
      .bind(spaceId, `${user.displayName}'s space`, user.createdAt), // rename via PATCH /api/spaces/:spaceId
    d1.prepare("INSERT INTO space_members (space_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
      .bind(spaceId, user.id, user.createdAt),
    credentialInsert(d1, user, cred),
  ]);
}

// register/verify, invite path: member + passkey + consume the invite, atomically and race-safe.
export async function registerInvitedUser(
  d1: D1Database,
  state: InviteState,
  user: NewUser,
  cred: NewCredential,
): Promise<Result<void, AuthError>> {
  const results = await d1.batch([
    d1.prepare("INSERT INTO users (id, display_name, created_at) VALUES (?, ?, ?)")
      .bind(user.id, user.displayName, user.createdAt),
    d1.prepare("INSERT INTO space_members (space_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
      .bind(state.spaceId, user.id, user.createdAt),
    credentialInsert(d1, user, cred),
    // LAST: the only statement whose row count carries meaning.
    d1.prepare("UPDATE invites SET consumed_at = ?, consumed_by_user_id = ? WHERE id = ? AND consumed_at IS NULL")
      .bind(user.createdAt, user.id, state.inviteId),
  ]);

  if ((results[results.length - 1]?.meta.changes ?? 0) === 0) {
    // Someone else consumed this invite between begin and verify. The inserts are already
    // committed (batch is atomic, but a 0-row UPDATE is not an error) — compensate in reverse order.
    await d1.batch([
      d1.prepare("DELETE FROM credentials WHERE user_id = ?").bind(user.id),
      d1.prepare("DELETE FROM space_members WHERE user_id = ?").bind(user.id),
      d1.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
    ]);
    return err({ type: "invite_race", message: "Invite was used by someone else" });
  }
  return ok(undefined);
}

// Column list = the passkey skill's `credentials` table; the bind order follows its NewCredential.
function credentialInsert(d1: D1Database, user: NewUser, cred: NewCredential): D1PreparedStatement {
  return d1
    .prepare(
      "INSERT INTO credentials (id, user_id, public_key, counter, transports, device_name, backed_up, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(cred.id, user.id, cred.publicKey, cred.counter, cred.transports, cred.deviceName, cred.backedUp ? 1 : 0, user.createdAt, user.createdAt);
}
```

### `AuthError` additions (passkey skill's `domain/auth.ts`)

```ts
export type AuthError =
  // …existing members (validation_error, registration_closed, unauthorized, challenge_mismatch, …)
  | { type: "invite_invalid"; message: string }
  | { type: "invite_consumed"; message: string }
  | { type: "invite_expired"; message: string }
  | { type: "invite_race"; message: string };

// and in authErrorResponse(error):
//   invite_invalid  → 403   invite_consumed → 410   invite_expired → 410   invite_race → 409
```

403 (hash unknown) vs 410 (known but dead) is deliberate: 403s in the logs are a brute-force signal, 410s are family confusion. Merge them into one error if you prefer to give the outside less information.

### How the passkey routes use it (orientation only — the routes live in `cloudflare-workers-passkey-auth`)

```ts
// register/begin — invite branch
const invite = await validateInvite(c.env.DB, body.inviteToken);
if (invite.isErr()) return fail(c, invite.error);           // 403 / 410 via authErrorResponse
const pendingUserId = crypto.randomUUID();
const options = await generateRegistrationOptions({ /* rpName, rpID, userID: pendingUserId, … */ });
const state: ChallengeState = {
  kind: "invite",
  uid: pendingUserId,
  displayName,                                              // already validated → 400 validation_error otherwise
  inviteId: invite.value.id,
  spaceId: invite.value.spaceId,
};
await issueChallenge(c, options.challenge, state);          // signed, HttpOnly, short TTL
return c.json({ options });                                 // nothing else: the invite never reaches the client

// register/verify — after verifyRegistrationResponse() succeeded; `ch` = the consumed challenge
const user = { id: ch.state.uid, displayName: ch.state.displayName, createdAt: now };
if (ch.state.kind === "initial") {
  await registerInitialUser(c.env.DB, user, cred);
} else if (ch.state.kind === "invite") {
  const r = await registerInvitedUser(c.env.DB, ch.state, user, cred);
  if (r.isErr()) return fail(c, r.error);                   // 409 invite_race (rows compensated)
}
await issueSession(c, UserId.parse(user.id));
```

Why the state lives in the cookie and not in the response: routine-tasks echoes `registration: { inviteId, spaceId }` to the client and trusts it back at `verify`. Nothing there re-checks the token, so a client that knows any unconsumed `inviteId` (visible to owners via `GET /invites`) could join that space. With the signed `ChallengeState`, `verify` has nothing to read from the body.

## Issue / list / revoke — space-scoped, owner only

```ts
// worker/routes/space-invites.ts  (mounted under /api/spaces/:spaceId/invites, behind spaceMiddleware)
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { invites } from "../db/schema";
import { requireOwner } from "../middleware/owner";
import { randomTokenHex, sha256Hex } from "../lib/token";
import type { SpaceEnv } from "../types";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const spaceInviteRoutes = new Hono<SpaceEnv>()
  .post("/", async (c) => {
    const db = drizzle(c.env.DB);
    if (!(await requireOwner(db, c.var.userId, c.var.spaceId))) {
      return c.json({ error: { type: "forbidden" } }, 403);
    }
    const token = randomTokenHex();
    const inviteId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
    await db.insert(invites).values({
      id: inviteId,
      spaceId: c.var.spaceId,
      tokenHash: await sha256Hex(token),
      role: "member",
      expiresAt,
      createdByUserId: c.var.userId,
      createdAt: now.toISOString(),
    });
    console.log("[invites] issued", inviteId); // never the token: Observability persists console output
    return c.json({
      token,
      inviteId,
      expiresAt,
      url: `${c.env.ORIGIN}/#/invite?token=${token}`, // fragment: never hits server logs or Referer
    }, 201);
  })
  .get("/", async (c) => {
    const db = drizzle(c.env.DB);
    if (!(await requireOwner(db, c.var.userId, c.var.spaceId))) {
      return c.json({ error: { type: "forbidden" } }, 403);
    }
    const rows = await db
      .select({ id: invites.id, expiresAt: invites.expiresAt, createdByUserId: invites.createdByUserId, createdAt: invites.createdAt })
      .from(invites)
      .where(and(eq(invites.spaceId, c.var.spaceId), isNull(invites.consumedAt), gt(invites.expiresAt, new Date().toISOString())))
      .orderBy(desc(invites.createdAt));
    return c.json(rows); // no tokens exist to show — only hashes are stored
  })
  .delete("/:inviteId", async (c) => {
    const db = drizzle(c.env.DB);
    if (!(await requireOwner(db, c.var.userId, c.var.spaceId))) {
      return c.json({ error: { type: "forbidden" } }, 403);
    }
    const where = and(eq(invites.id, c.req.param("inviteId")), eq(invites.spaceId, c.var.spaceId));
    const existing = await db.select({ id: invites.id }).from(invites).where(where);
    if (existing.length === 0) return c.json({ error: { type: "not_found" } }, 404);
    await db.delete(invites).where(where); // revoke = delete; keep consumed rows for audit if you prefer
    return c.json({});
  });
```

## Path (B): logged-in user joins another space

```ts
// worker/routes/invite-accept.ts  (mounted at /api/invites, behind sessionMiddleware, NOT spaceMiddleware)
import { Hono } from "hono";
import { authErrorResponse } from "../domain/auth"; // passkey skill
import { validateInvite } from "../spaces/registration";
import type { Env } from "../types";

export const inviteAcceptRoutes = new Hono<Env>().post("/accept", async (c) => {
  const body = await c.req.json<{ token?: string }>().catch(() => ({}));
  if (typeof body.token !== "string") return c.json({ error: { type: "invite_invalid" } }, 403);

  const found = await validateInvite(c.env.DB, body.token);
  if (found.isErr()) {
    const { body: errBody, status } = authErrorResponse(found.error);
    return c.json(errBody, status);
  }
  const { id: inviteId, spaceId } = found.value;

  // Already a member: do not burn the invite (the link may be meant for someone else on this phone).
  if (c.var.memberSpaceIds.includes(spaceId as (typeof c.var.memberSpaceIds)[number])) {
    return c.json({ error: { type: "already_member" } }, 409);
  }

  const now = new Date().toISOString();
  const DB = c.env.DB;
  const results = await DB.batch([
    DB.prepare("INSERT INTO space_members (space_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)")
      .bind(spaceId, c.var.userId, now),
    DB.prepare("UPDATE invites SET consumed_at = ?, consumed_by_user_id = ? WHERE id = ? AND consumed_at IS NULL")
      .bind(now, c.var.userId, inviteId), // LAST
  ]);
  if ((results[results.length - 1]?.meta.changes ?? 0) === 0) {
    await DB.prepare("DELETE FROM space_members WHERE space_id = ? AND user_id = ?").bind(spaceId, c.var.userId).run();
    return c.json({ error: { type: "invite_race" } }, 409);
  }
  return c.json({ spaceId }, 201);
});
```

This path is a design extension (routine-tasks shipped only path A) — UNVERIFIED in production; exercise `already_member` and a double-submit by hand.

## Client: the link and what the SPA does with it

```ts
// src/invite.ts — hash-router app: https://<app>/#/invite?token=<hex>
export function readInviteToken(): string | null {
  const query = location.hash.split("?")[1] ?? "";
  return new URLSearchParams(query).get("token");
}
// history-router app: https://<app>/invite#token=<hex>
//   → new URLSearchParams(location.hash.slice(1)).get("token")

// After a successful register/accept, drop the token from the address bar. Never persist it.
history.replaceState(null, "", location.pathname + "#/");
```

Flow on the invite page: no session → display-name form → `POST /api/auth/register/begin { inviteToken, displayName }` → `{ options }` → WebAuthn ceremony (`startRegistration`) → `POST /api/auth/register/verify { response, deviceName }` → session cookie. Session present → `POST /api/invites/accept { token }`. Both end with `GET /api/spaces` (the joined space is now listed) and navigating to `/#/spaces/<spaceId>`. The client never receives or sends `inviteId` / `spaceId` during registration.

## Error table

| Status | `error.type` | Where | Client action |
|---|---|---|---|
| 403 | `invite_invalid` | `validateInvite` (begin / accept) | "This link is not valid" |
| 410 | `invite_consumed` | `validateInvite` (begin / accept) | "Already used — ask for a new link" |
| 410 | `invite_expired` | `validateInvite` (begin / accept) | "Expired — ask for a new link" |
| 400 | `validation_error` | begin (passkey skill's display-name check) | form error |
| 409 | `invite_race` | `registerInvitedUser` (verify) / accept | retry with a new link (rows were compensated) |
| 409 | `already_member` | accept | go to the space |
| 403 | `forbidden` | issue / list / revoke | not an owner |
