# Middleware: membership resolution, `spaceMiddleware`, owner helpers, router mounting

One responsibility per layer. `sessionMiddleware` answers "who" and "which spaces"; `spaceMiddleware` answers "is `:spaceId` one of them" (404 otherwise); handlers answer "is this action owner-level" and run SQL scoped by `c.var.spaceId`.

## Types

```ts
// worker/types.ts
import type { DisplayName, UserId } from "./domain/auth"; // from cloudflare-workers-passkey-auth
import type { SpaceId } from "./domain/space";

export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  SESSION_SECRET: string;
  ORIGIN: string;
  DEV_BYPASS_USER_ID?: string; // dev only, .dev.vars — never a production secret
  // + auth-skill bindings (RP_ID, INITIAL_REGISTRATION_TOKEN, AUTH_RATE_LIMITER, …)
};

export type SessionVars = {
  userId: UserId;
  displayName: DisplayName;
  memberSpaceIds: SpaceId[];
};
export type SpaceVars = SessionVars & { spaceId: SpaceId };

export type Env = { Bindings: Bindings; Variables: SessionVars };
export type SpaceEnv = { Bindings: Bindings; Variables: SpaceVars };
```

```ts
// worker/domain/space.ts
import { z } from "zod";

export type SpaceId = string & { readonly __brand: unique symbol };
export const SpaceId = z
  .string()
  .uuid()
  .transform((v) => v as SpaceId);
```

## `sessionMiddleware`: resolve `memberSpaceIds` per request

Only the membership part is shown; the cookie / JWT / `sessions` validation is in `cloudflare-workers-passkey-auth`.

```ts
// worker/middleware/membership.ts
import { eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import { spaceMembers, spaces } from "../db/schema";
import { SpaceId } from "../domain/space";
import type { UserId } from "../domain/auth";

export async function loadMemberSpaceIds(
  db: ReturnType<typeof drizzle>,
  userId: UserId,
): Promise<SpaceId[]> {
  const rows = await db
    .select({ spaceId: spaceMembers.spaceId })
    .from(spaceMembers)
    .where(eq(spaceMembers.userId, userId));
  return rows.map((r) => SpaceId.parse(r.spaceId));
}

// Dev bypass helper: a fixed space the bypass user always owns, so memberSpaceIds
// is non-empty and dev-mode INSERTs have a space to bind to. Call it only from the
// DEV_BYPASS branch (value set AND local ORIGIN — the twin guard).
export const DEV_SPACE_ID = "00000000-0000-4000-8000-000000000001";

export async function ensureDevSpace(
  db: ReturnType<typeof drizzle>,
  userId: UserId,
  now: string,
): Promise<void> {
  await db
    .insert(spaces)
    .values({ id: DEV_SPACE_ID, name: "dev", createdAt: now })
    .onConflictDoNothing();
  await db
    .insert(spaceMembers)
    .values({ spaceId: DEV_SPACE_ID, userId, role: "owner", createdAt: now })
    .onConflictDoNothing();
}
```

```ts
// worker/middleware/session.ts — the tail of the happy path, after the session row is validated
const userId = UserId.parse(row.userId);
c.set("userId", userId);
c.set("displayName", DisplayName.parse(row.displayName));
c.set("memberSpaceIds", await loadMemberSpaceIds(db, userId)); // 1 query, every request, not in the JWT
await next();
```

Why not cache or embed: `DELETE /members/:userId` must take effect on the victim's next request. One indexed query per request is free at family scale.

## `spaceMiddleware`: 404 for anything that is not my space

```ts
// worker/middleware/space.ts
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import { SpaceId } from "../domain/space";
import type { SpaceEnv } from "../types";

// Same body for malformed, missing and foreign ids. 403 would confirm existence.
function notFound(c: Context<SpaceEnv>) {
  return c.json({ error: { type: "not_found" } }, 404);
}

export const spaceMiddleware = createMiddleware<SpaceEnv>(async (c, next) => {
  const raw = c.req.param("spaceId") ?? "";
  const parsed = SpaceId.safeParse(raw);
  if (!parsed.success) {
    // console.error stays: it is how e2e 404s are diagnosed. Never echo it in the body.
    console.error("[spaceMiddleware] 404: malformed spaceId", raw);
    return notFound(c);
  }
  if (!c.var.memberSpaceIds.includes(parsed.data)) {
    console.error("[spaceMiddleware] 404: not a member", parsed.data, c.var.userId);
    return notFound(c);
  }
  c.set("spaceId", parsed.data);
  await next();
});
```

## Owner helpers — called inside handlers, never as prefix middleware

```ts
// worker/middleware/owner.ts
import { and, count, eq } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/d1";
import { spaceMembers } from "../db/schema";

type Db = ReturnType<typeof drizzle>;

export async function requireOwner(db: Db, userId: string, spaceId: string): Promise<boolean> {
  const rows = await db
    .select({ role: spaceMembers.role })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)));
  return rows[0]?.role === "owner";
}

// True when removing targetUserId would leave the space with no owner.
export async function isLastOwner(db: Db, spaceId: string, targetUserId: string): Promise<boolean> {
  const target = await db
    .select({ role: spaceMembers.role })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, targetUserId)));
  if (target[0]?.role !== "owner") return false;
  const owners = await db
    .select({ n: count() })
    .from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.role, "owner")));
  return (owners[0]?.n ?? 0) <= 1;
}
```

Usage in an owner-level handler:

```ts
if (!(await requireOwner(db, c.var.userId, c.var.spaceId))) {
  return c.json({ error: { type: "forbidden" } }, 403); // 403 is fine HERE: membership is already proven
}
```

`GET /members` on the same prefix is member-level — which is why the owner check is not middleware.

## Router mounting

```ts
// worker/index.ts (the /api part; secureHeaders, onError, /health, notFound→ASSETS as in the skeleton)
import { Hono } from "hono";
import { authRoutes } from "./routes/auth";                 // passkey skill: public + own session guards
import { mySpacesRoutes } from "./routes/spaces";           // GET /api/spaces
import { inviteAcceptRoutes } from "./routes/invite-accept"; // POST /api/invites/accept
import { spaceDetailRoutes } from "./routes/space-detail";  // GET/PATCH /, /members
import { spaceInviteRoutes } from "./routes/space-invites"; // POST/GET/DELETE invites
import { mealRoutes } from "./routes/meals";
import { sessionMiddleware } from "./middleware/session";
import { spaceMiddleware } from "./middleware/space";
import type { Env, SpaceEnv } from "./types";

const api = new Hono<Env>();
api.route("/auth", authRoutes);

const protectedApi = new Hono<Env>();
protectedApi.use("/*", sessionMiddleware());
protectedApi.route("/spaces", mySpacesRoutes);      // list: outside spaceMiddleware
protectedApi.route("/invites", inviteAcceptRoutes); // accept: outside spaceMiddleware

const space = new Hono<SpaceEnv>();
space.use("*", spaceMiddleware);                    // everything below needs membership
space.route("/", spaceDetailRoutes);
space.route("/invites", spaceInviteRoutes);
space.route("/meals", mealRoutes);
protectedApi.route("/spaces/:spaceId", space);

api.route("/", protectedApi);
app.route("/api", api);
```

`space.use("*", spaceMiddleware)` reads `c.req.param("spaceId")` from the mount path — routine-tasks runs this shape on Hono 4 (UNVERIFIED for your pinned version; confirm with one request before building on it).

## Handlers scoped by `c.var.spaceId`

```ts
// worker/routes/meals.ts
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq } from "drizzle-orm";
import { meals } from "../db/schema";
import type { SpaceEnv } from "../types";

export const mealRoutes = new Hono<SpaceEnv>()
  .get("/", async (c) => {
    const db = drizzle(c.env.DB);
    const rows = await db
      .select()
      .from(meals)
      .where(eq(meals.spaceId, c.var.spaceId))
      .orderBy(desc(meals.eatenAt));
    return c.json(rows);
  })
  .get("/:id", async (c) => {
    const db = drizzle(c.env.DB);
    const rows = await db
      .select()
      .from(meals)
      .where(and(eq(meals.id, c.req.param("id")), eq(meals.spaceId, c.var.spaceId))); // both, always
    if (rows.length === 0) return c.json({ error: { type: "not_found" } }, 404);
    return c.json(rows[0]);
  })
  .post("/", async (c) => {
    const db = drizzle(c.env.DB);
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    // ...validate body...
    await db.insert(meals).values({
      id,
      spaceId: c.var.spaceId,      // from the middleware, never from the body
      name: body.name,
      eatenAt: body.eatenAt,
      note: body.note ?? null,
      createdBy: c.var.userId,     // audit
      createdAt: now,
      updatedAt: now,
    });
    return c.json({ id }, 201);
  });
```

Children (`meal_tags`, photos) are scoped by joining the parent: `... FROM meal_tags JOIN meals ON meals.id = meal_tags.meal_id WHERE meals.space_id = ?`.

## The flat-URL alternative (nyalog) and its empty-list guard

If you keep `/api/meals/:id` without a `:spaceId` segment, every handler must resolve the parent against **all** member spaces:

```ts
export async function resolveMeal(db: Db, rawId: string, memberSpaceIds: SpaceId[]) {
  const parsed = MealId.safeParse(rawId);
  if (!parsed.success) return null;
  if (memberSpaceIds.length === 0) return null; // explicit: do not hand [] to inArray (UNVERIFIED ORM behaviour)
  const rows = await db
    .select({ id: meals.id, spaceId: meals.spaceId })
    .from(meals)
    .where(and(eq(meals.id, parsed.data), inArray(meals.spaceId, memberSpaceIds)));
  return rows[0] ?? null; // null → 404 (existence hiding)
}
```

It works for a single fixed space, but the check is repeated per handler and the empty-array case is a foot-gun. For a new app, put `:spaceId` in the URL and let `spaceMiddleware` do it once.
