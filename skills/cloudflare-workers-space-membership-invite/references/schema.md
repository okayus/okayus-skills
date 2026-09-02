# Schema: `spaces`, `space_members`, `invites`, and the domain-table rule

Drizzle (`drizzle-orm/sqlite-core`) source first, then the SQL drizzle-kit should generate for it. `users` (plus `credentials` / `sessions`) is owned by `cloudflare-workers-passkey-auth`; it is shown minimally so the foreign keys resolve.

## Drizzle schema

```ts
// worker/db/schema.ts
import { sql } from "drizzle-orm";
import { check, index, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Owned by cloudflare-workers-passkey-auth — keep a single definition, import it there.
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  displayName: text("display_name").notNull(),
  createdAt: text("created_at").notNull(),
});

export const spaces = sqliteTable("spaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
});

export const spaceMembers = sqliteTable(
  "space_members",
  {
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "member"] }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.spaceId, t.userId] }),
    // sessionMiddleware runs `WHERE user_id = ?` on every request — index it.
    index("space_members_user_id_idx").on(t.userId),
    // drizzle-kit 0.31 emits this CHECK for sqlite (verified 2026-08-30 in matatabetai)
    check("space_members_role_check", sql`${t.role} IN ('owner', 'member')`),
  ],
);

export const invites = sqliteTable(
  "invites",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    // sha256 hex of the plain token. The plain token exists only in the issue response.
    tokenHash: text("token_hash").notNull(),
    // Invites never mint owners. Promote by SQL (ops.md) if a second owner is needed.
    role: text("role", { enum: ["member"] }).notNull(),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    consumedByUserId: text("consumed_by_user_id").references(() => users.id, {
      onDelete: "set null", // audit survives user deletion
    }),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("invites_token_hash_uniq").on(t.tokenHash),
    index("invites_space_id_idx").on(t.spaceId),
    check("invites_role_check", sql`${t.role} = 'member'`),
  ],
);

// ---- Domain example (matatabetai). Parents carry space_id; children join through them. ----

export const meals = sqliteTable(
  "meals",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull() // NOT NULL from the first migration — never retrofitted
      .references(() => spaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    eatenAt: text("eaten_at").notNull(),
    note: text("note"),
    // Audit only. SET NULL so `DELETE FROM users` never fails on this FK.
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => ({
    spaceEatenIdx: index("meals_space_id_eaten_at_idx").on(t.spaceId, t.eatenAt),
  }),
);

// `tags` has its own list endpoint (tag search / suggestions) → it is a parent and carries space_id.
export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // store normalized (NFKC, trimmed); search with LIKE
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    spaceNameUniq: uniqueIndex("tags_space_id_name_uniq").on(t.spaceId, t.name),
  }),
);

// Pure join table: scope is reachable through both parents, so no space_id here.
export const mealTags = sqliteTable(
  "meal_tags",
  {
    mealId: text("meal_id")
      .notNull()
      .references(() => meals.id, { onDelete: "cascade" }),
    tagId: text("tag_id")
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.mealId, t.tagId] }),
    tagIdIdx: index("meal_tags_tag_id_idx").on(t.tagId), // tag → meals search
  }),
);
```

## SQL the first migration must contain

```sql
CREATE TABLE spaces (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE space_members (
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (space_id, user_id)
);
CREATE INDEX space_members_user_id_idx ON space_members(user_id);

CREATE TABLE invites (
  id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role = 'member'),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  consumed_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_by_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX invites_token_hash_uniq ON invites(token_hash);
CREATE INDEX invites_space_id_idx ON invites(space_id);

CREATE TABLE meals (
  id TEXT PRIMARY KEY NOT NULL,
  space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  eaten_at TEXT NOT NULL,
  note TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX meals_space_id_eaten_at_idx ON meals(space_id, eaten_at);
-- tags / meal_tags analogous (see the Drizzle source above)
```

The `CHECK` constraints: drizzle's `text(..., { enum })` is **type-level only** and emits no `CHECK`. Declare them with `check(name, sql\`…\`)` in the table's extra config (array form, drizzle-orm ≥ 0.36) — drizzle-kit 0.31.10 emits `CONSTRAINT "…" CHECK(…)` in the generated SQL and local D1 enforces it (verified 2026-08-30 in matatabetai). routine-tasks wrote the migrations by hand with the `CHECK`s above.

## `ON DELETE` choices — why each one

| FK | Action | Reason |
|---|---|---|
| `space_members.space_id → spaces` | CASCADE | deleting a space removes its memberships |
| `space_members.user_id → users` | CASCADE | deleting a user leaves no dangling membership |
| `invites.space_id → spaces` | CASCADE | pending invites die with the space |
| `invites.created_by_user_id → users` | CASCADE | issuer gone → invite gone (it was theirs to revoke) |
| `invites.consumed_by_user_id → users` | SET NULL | keep "this invite was used" as audit even after the user is deleted |
| `meals.space_id → spaces` | CASCADE | a space is the unit of deletion |
| `meals.created_by → users` | **SET NULL** | audit only; the default `NO ACTION` makes `DELETE FROM users` fail once the user has any row |
| `meal_tags.* → meals / tags` | CASCADE | join rows follow their parents |

D1 enforces foreign keys (that is exactly why the nyalog rebuild cascaded), so every `DELETE` path above is real behaviour, not documentation.

## The rule for new domain tables

1. Does the entity have its own list endpoint or its own lifecycle? → **parent**: `space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE` + an index starting with `space_id`.
2. Is it only ever addressed through a parent (`/meals/:id/photos`, `meal_tags`)? → **child**: FK to the parent with CASCADE, **no** `space_id`. Authorization is inherited by joining the parent (`WHERE meals.space_id = ?`).
3. Every table that records who did something gets `created_by … ON DELETE SET NULL`; it is never used in an authorization `WHERE`.
4. Never add `space_id` later as NULLABLE-then-NOT-NULL on a CASCADE parent. If you inherit such a table, read `cloudflare-d1-drizzle-migration` before touching it.
