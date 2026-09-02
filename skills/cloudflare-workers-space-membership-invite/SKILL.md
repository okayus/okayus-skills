---
name: cloudflare-workers-space-membership-invite
description: Add per-space membership authorization and single-use invite links to a Hono + D1 Cloudflare Worker so a family shares one space and outsiders get 404, never 403. Use when choosing the authorization model of a new multi-user Workers app, or on these symptoms — a logged-in user can read another family's data by guessing an id, a 403 leaks that a space exists, an invite link works twice, a removed member still has access. Covers why `space_id NOT NULL` belongs in the first migration (retrofitting cost nyalog 1257 child rows to D1 ignoring `PRAGMA foreign_keys=OFF`), the spaces / space_members / invites schema, one-responsibility middleware (memberSpaceIds resolved per request, non-member spaces hidden as 404, owner checks per handler, last-owner guard), sha256-hashed 7-day invite tokens, the race-safe D1 batch (`UPDATE … WHERE consumed_at IS NULL` last, `meta.changes === 0` → compensating deletes + 409), atomic owner bootstrap, and the cross-space e2e seed. Auth-agnostic (passkey or OAuth).
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets Cloudflare Workers with Hono 4 + Drizzle ORM + D1 (SQLite) on the cloudflare-workers-deploy-skeleton stack (Vite + @cloudflare/vite-plugin, pnpm). Needs a session layer that sets c.var.userId — passkeys via cloudflare-workers-passkey-auth, or third-party OAuth. The invite-consuming transaction uses the raw D1 binding (env.DB.batch); Drizzle everywhere else. Requires wrangler CLI.
metadata:
  author: okayus
  version: "0.2.0"
---

# Per-space membership + invite links on Cloudflare Workers

Extracted from nyalog (ADR-004/005) and routine-tasks (ADR-0001, Phase 4a/4b), 2026-08-22.

Get a multi-user Workers app to the state where **every domain row belongs to a space, every request carries the caller's `memberSpaceIds`, non-member spaces are indistinguishable from non-existent ones (404), and a new family member joins through a single-use invite link** — with the schema shaped this way in the first migration, not retrofitted.

**Why do this first**: authorization is the one part of the data model you cannot change later without a table rebuild. nyalog started as "every authenticated user sees everything", added `space_id` as NULLABLE, backfilled by hand, and then lost all 1257 child rows when the NOT NULL flip rebuilt the parent table (D1 ignores `PRAGMA foreign_keys=OFF`, so the rebuild's `DROP TABLE` cascaded). routine-tasks, designed per-space from day 1, needed none of that: one migration, one atomic bootstrap, invites one phase later.

## When to use this skill

- Starting a Workers + D1 app where more than one account shares data (family, household, small team) and you must decide the authorization model
- Adding "invite someone to my space" to an app that already has sessions
- Symptoms in an existing app:
  - a logged-in user can read or modify another group's rows by guessing a UUID (IDOR)
  - non-member resources return **403**, which tells an attacker the id exists
  - an invite token works more than once, or two people race on the same link
  - a removed member keeps access until their JWT expires (memberships embedded in the token)
- Auth-method-agnostic: the session layer may be passkeys (`cloudflare-workers-passkey-auth`) or OAuth — this skill only needs `c.var.userId`

Do **not** use for: single-user apps (keep `WHERE user_id = ?`), public UGC services where content is world-readable by design (you still want `created_by`, but not spaces), or RBAC with more than two roles (extend; don't adopt verbatim).

## Deliverables (completion criteria)

- [ ] First migration creates `spaces`, `space_members`, `invites` **and** every domain parent table with `space_id TEXT NOT NULL REFERENCES spaces(id)`
- [ ] `sessionMiddleware` sets `c.var.userId` and `c.var.memberSpaceIds` (one query per request; nothing authorization-related inside the JWT)
- [ ] `spaceMiddleware` on `/api/spaces/:spaceId/*` returns `404 {"error":{"type":"not_found"}}` for malformed ids and for ids outside `memberSpaceIds`; sets `c.var.spaceId`
- [ ] Owner-only handlers (`POST /invites`, `DELETE /members/:userId`, `PATCH` rename) call `requireOwner` inside the handler; `DELETE /members/:userId` refuses the last owner with `400 last_owner`
- [ ] `POST /api/spaces/:spaceId/invites` stores only `sha256(token)`, returns the plain token once, 7-day expiry
- [ ] Invite consumption (`registerInvitedUser` / `POST /api/invites/accept`) is one `env.DB.batch([...])` with `UPDATE invites … WHERE consumed_at IS NULL` as the **last** statement; `meta.changes === 0` → compensating deletes + `409 invite_race`
- [ ] `register/begin` validates the token with `validateInvite` and stores `{ kind: "invite", uid, displayName, inviteId, spaceId }` as the signed challenge-cookie state (`ChallengeState`); `register/verify` hands that state to `registerInvitedUser` — the client only ever receives `{ options }` and never echoes invite state
- [ ] First registration (`registerInitialUser`) creates `users` + `spaces` + `space_members(owner)` + `credentials` in one batch — no manual bootstrap SQL
- [ ] Dev bypass (if any) auto-joins a fixed `DEV_SPACE_ID` so `memberSpaceIds` is never empty in dev
- [ ] e2e authorization-boundary spec: authed user → seeded "other family" space → API 404 with the exact body + UI access-denied
- [ ] `created_by` columns are audit-only (`ON DELETE SET NULL`), never part of a `WHERE` used for authorization

## The decision: per-space membership from day 1

| Model | Schema | Fails when |
|---|---|---|
| per-user ownership (`WHERE user_id = ?`) | rows carry `user_id` | a family shares one list → duplicates, "only the creator can edit" |
| implicit family-shared (nyalog ADR-004) | no scope column; any authenticated user sees all | a second family / test account / "who can see this" has no answer; the retrofit is a table rebuild |
| **per-space membership** (adopt) | `spaces`, `space_members(space_id, user_id, role)`, `<parent>.space_id NOT NULL` | only at SaaS scale (dozens of spaces per user → cache `memberSpaceIds`) |

Rules that follow:

1. **Parents carry `space_id`; children join through the parent.** `meals.space_id`, but `meal_tags` / `meal_photos` reach the space via `meal_id` — no duplicated scope column to drift. An entity is a parent when it has its own list endpoint (`tags` is one, `meal_tags` is not).
2. **`created_by` is an audit attribute, not an authorization key** (ADR-004). Everyone in the space edits everyone's rows; `created_by` drives a badge and is `ON DELETE SET NULL` so deleting a user never blocks on FK.
3. **Single-space UX is fine.** Hide the switcher; keep the model. The URL still says `/spaces/:spaceId/…`.
4. **`NOT NULL` in the first migration.** Never "add nullable → backfill → flip" on a table that is a CASCADE parent — that is the rebuild that bit nyalog. Mechanism and runbook: `cloudflare-d1-drizzle-migration`.

## Schema in one screen

```sql
spaces        (id PK, name, created_at)
space_members (space_id FK→spaces CASCADE, user_id FK→users CASCADE,
               role CHECK IN ('owner','member'), created_at,
               PK (space_id, user_id), INDEX (user_id))
invites       (id PK, space_id FK→spaces CASCADE, token_hash UNIQUE,
               role CHECK = 'member', expires_at, consumed_at,
               consumed_by_user_id FK→users SET NULL,
               created_by_user_id FK→users CASCADE, created_at)
meals         (id PK, space_id FK→spaces CASCADE NOT NULL, …, created_by FK→users SET NULL)
tags          (id PK, space_id FK→spaces CASCADE NOT NULL, name, UNIQUE (space_id, name))
meal_tags     (meal_id FK→meals CASCADE, tag_id FK→tags CASCADE, PK)   -- scope via parents
```

Drizzle source, generated SQL, `ON DELETE` choices and the index rationale: [references/schema.md](references/schema.md).

## Middleware layering — one responsibility each

| Layer | Sets / checks | Never does |
|---|---|---|
| `sessionMiddleware` | `userId`, `displayName`, `memberSpaceIds` (`SELECT space_id FROM space_members WHERE user_id = ?`) | per-space decisions |
| `spaceMiddleware` (`/api/spaces/:spaceId/*`) | `spaceId` parses as a UUID **and** is in `memberSpaceIds`, else **404**; sets `c.var.spaceId` | role checks |
| handler | `requireOwner` where the action is owner-level; `isLastOwner` before removal; SQL scoped by `c.var.spaceId` | re-checking membership |

**404, not 403.** 403 says "exists, not yours"; an id-guessing attacker learns which UUIDs are real. Return the same `{"error":{"type":"not_found"}}` for malformed, missing and foreign ids. Keep the `console.error("[spaceMiddleware] 404 …")` lines — they are how you diagnose e2e failures — but never echo the reason in the body.

**Why `memberSpaceIds` is one query per request and not a JWT claim**: removal must take effect on the next request. At family scale the query is free; revisit only when a user belongs to dozens of spaces.

**Why owner checks live in handlers, not middleware**: `GET /members` is member-level, `POST /invites` is owner-level, same prefix. An owner middleware on the prefix turns every read into 403 for members.

**URL design**: prefer `/api/spaces/:spaceId/<resource>` (routine-tasks) for a new app — membership is checked once, handlers use `WHERE space_id = ?`. nyalog's flat `/api/cats/:catId` with `inArray(cats.spaceId, memberSpaceIds)` works for one fixed space but every handler must repeat the lookup **and guard the empty list explicitly** (`memberSpaceIds.length === 0 → 404` before `inArray`). Both shapes with code: [references/middleware.md](references/middleware.md).

## Invite flow

```
owner   POST /api/spaces/:spaceId/invites           → { token, inviteId, expiresAt, url }  (plain token: once)
        DB:  INSERT invites(token_hash = sha256(token), role = 'member', expires_at = now + 7d)
owner   sends  https://<app>/#/invite?token=<token>  out of band (LINE, in person)
family  opens the link → SPA reads the fragment → register (A) or accept (B)
```

Token rules: 32 random bytes (`crypto.getRandomValues`) → hex; the DB holds only the `sha256` hex (`token_hash UNIQUE`); lookup by hash; `expires_at` = 7 days; `consumed_at` / `consumed_by_user_id` enforce single use; `role CHECK (role = 'member')` — invites never mint owners (promote by SQL, see ops).

Three accept paths, one consumption rule:

- **(A) new user via passkey registration** — contract with `cloudflare-workers-passkey-auth`, implemented in this skill's `worker/spaces/registration.ts`: `register/begin` with `inviteToken` calls `validateInvite` (`403 invite_invalid` / `410 invite_consumed` / `410 invite_expired`; the display name fails with the passkey skill's `400 validation_error`), stores `{ kind: "invite", uid: pendingUserId, displayName, inviteId, spaceId }` as the signed challenge-cookie state via `issueChallenge(c, challenge, state)`, and returns only `{ options }`. `register/verify` hands the consumed state to `registerInvitedUser`, which runs **one** batch: `users` → `space_members(member)` → `credentials` → `UPDATE invites` (last); the session row comes afterwards from `issueSession`.
- **(B) logged-in user joining another space** — `POST /api/invites/accept { token }` (session-protected, not space-scoped): already a member → `409 already_member` without consuming; otherwise batch `space_members` → `UPDATE invites`. Design extension over routine-tasks — see Unverified.
- **(C) OAuth** — log in first, then (B).

The consumption rule (the part that is easy to get wrong):

```ts
const results = await c.env.DB.batch([
  ...inserts, // users, space_members, credentials — prepared statements (the session row comes later via issueSession)
  c.env.DB.prepare(
    "UPDATE invites SET consumed_at = ?, consumed_by_user_id = ? WHERE id = ? AND consumed_at IS NULL",
  ).bind(now, userId, inviteId), // LAST
]);
if ((results[results.length - 1]?.meta.changes ?? 0) === 0) {
  await c.env.DB.batch([/* reverse-order DELETEs of the inserts */]);
  return c.json({ error: { type: "invite_race" } }, 409);
}
```

`batch()` is atomic (any SQL error rolls everything back) but a `WHERE` that matches zero rows is **not** an error — the batch "succeeds" with `changes: 0`. So the UPDATE goes last, its row count is asserted, and the already-committed inserts are compensated by hand. D1 has no `SELECT … FOR UPDATE`; this is the substitute. `registration.ts` (`validateInvite` / `registerInvitedUser` / `registerInitialUser`), the `AuthError` additions, the routes and client fragment parsing: [references/invite-flow.md](references/invite-flow.md).

| Status | `error.type` | Meaning |
|---|---|---|
| 403 | `invite_invalid` | hash not found (brute-force signal) |
| 410 | `invite_consumed` | used already (checked before expiry) |
| 410 | `invite_expired` | TTL passed, never used |
| 400 | `validation_error` | display name rejected (passkey skill's input error) |
| 409 | `invite_race` | lost the consumption race; rows compensated |
| 409 | `already_member` | (B) only; token not consumed |

## Member management endpoints

| Route | Who | Notes |
|---|---|---|
| `GET /api/spaces` | member | my spaces with `role`, `memberCount` |
| `GET /api/spaces/:spaceId` | member | `spaceMiddleware` already proved membership |
| `PATCH /api/spaces/:spaceId` | owner | rename |
| `GET /api/spaces/:spaceId/members` | member | list with role, joinedAt |
| `DELETE /api/spaces/:spaceId/members/:userId` | owner | `400 last_owner` guard; `404` if not a member |
| `POST /api/spaces/:spaceId/invites` | owner | issue |
| `GET /api/spaces/:spaceId/invites` | owner | pending (no tokens — only hashes exist) |
| `DELETE /api/spaces/:spaceId/invites/:inviteId` | owner | revoke = delete the row |
| `POST /api/invites/accept` | any session | path (B) |

Two roles only. Owner promotion is a one-line SQL in ops, not an endpoint — add one when a second owner is actually needed.

## Bootstrap and dev

- **First owner**: the passkey skill's `INITIAL_REGISTRATION_TOKEN` path calls this skill's `registerInitialUser`, which creates `users` + `spaces` + `space_members(owner)` + `credentials` in one `batch`; `issueSession` then adds the session row. No hand-written bootstrap SQL, no NULL `space_id` window. (nyalog's `2026-04-22-space-bootstrap.sql` is what retrofitting costs.)
- **Dev bypass** (`DEV_BYPASS_USER_ID`, local origin only): also `INSERT … ON CONFLICT DO NOTHING` a fixed `DEV_SPACE_ID` space and an owner membership (`ensureDevSpace`), so `memberSpaceIds` is non-empty and dev INSERTs have a space to bind to.
- **Drizzle vs raw D1**: Drizzle for everything except the registration / invite batches (`registerInitialUser`, `registerInvitedUser`, `POST /api/invites/accept`), which use `env.DB.prepare().bind()` inside `env.DB.batch()` because they need per-statement `meta.changes` — pass the raw binding `c.env.DB`.

## e2e: the authorization-boundary spec

Seed an "other family" with fixed UUIDs in `global-setup.ts` (`INSERT OR IGNORE`, `wrangler d1 execute <db> --local`): user → space → membership → one domain row, in FK order. The spec: register or log in as a fresh user, `GET /api/spaces/<OTHER_SPACE_ID>/meals` → `404` with body exactly `{"error":{"type":"not_found"}}`, then `page.goto("/#/spaces/<OTHER_SPACE_ID>")` shows the access-denied view. With OAuth, switch the seeded-session token instead of registering. Playwright wiring, the virtual authenticator and the seeded-session seam live in `cloudflare-workers-e2e-playwright`; the seed + spec bodies are in [references/e2e-cross-space.md](references/e2e-cross-space.md).

## The pitfalls that eat hours

- **403 instead of 404** — leaks existence. One body for every non-member outcome.
- **Owner check in middleware** — members get 403 on reads. Check role per handler.
- **Memberships in the JWT** — a removed member keeps access until expiry. Resolve per request.
- **`changes: 0` is success** in `D1Database.batch()` — put the consuming `UPDATE … WHERE consumed_at IS NULL` last, assert `meta.changes`, compensate.
- **Client-echoed registration state** — routine-tasks sends `registration: { inviteId, spaceId }` to the client and trusts it back at `verify`; anyone who learns an unconsumed `inviteId` (a UUID shown in `GET /invites`) could join without the token. In this contract the invite lives only in the signed `ChallengeState` cookie; `register/verify` must never read `inviteId` / `spaceId` / `uid` from the request body.
- **Retrofitting `space_id NOT NULL`** rebuilds a CASCADE parent on D1 and deletes children (nyalog: 1257 rows). Design it in; if you must retrofit, follow `cloudflare-d1-drizzle-migration` (backup, drop the CASCADE first, count after).
- **`inArray(col, [])`** — guard `memberSpaceIds.length === 0` explicitly before building the query; don't rely on the ORM's empty-list behaviour.
- **`created_by` with the default FK action** blocks `DELETE FROM users` once that user has rows (D1 enforces foreign keys). Use `ON DELETE SET NULL` for audit columns.
- **Seeding with `INSERT OR IGNORE` out of FK order** — insert `users` → `spaces` → `space_members` → parent rows → children. Ignore-on-conflict does not hide FK errors.
- **Plain token in logs** — with Workers Observability at `head_sampling_rate: 1`, any `console.log` of the token is persisted. Log `inviteId`, never the token. Put the token in the URL **fragment** so it never reaches server logs or `Referer`.
- **`spaceMiddleware` on the wrong prefix** — mount it on the sub-router that owns `/:spaceId`; `GET /api/spaces` (list) and `POST /api/invites/accept` sit outside it.

## Unverified claims — confirm while implementing, then write back

Record outcomes in this section (PR to okayus-skills) and in the app's ADR.

- UNVERIFIED: the fragment-based invite link survives LINE's in-app browser on iOS/Android. matatabetai uses a history router with `/invite#token=…` and Chromium keeps the fragment through the SPA's initial load (verified 2026-08-30 in e2e) — verify on a real phone via LINE.

### Verified 2026-08-30 in matatabetai (first production user of this skill)

- drizzle-orm 0.45.2 `inArray(col, [])` emits `sql\`false\`` (`sql/expressions/conditions.js`) — no throw. Keep the explicit empty guard anyway; matatabetai avoids the question by putting `:spaceId` in the URL.
- Raw `D1Database.batch()` on workerd exposes per-statement `meta.changes`; a 0-row `UPDATE … WHERE consumed_at IS NULL` returns `success: true, changes: 0`, so the race check as written detects the lost race. `db.$client` was not needed — pass `c.env.DB`.
- D1 `batch()` rolls back the whole batch on a mid-batch constraint violation (a duplicate `users.id` as the 2nd statement raised `D1_ERROR: UNIQUE constraint failed` and the 1st INSERT was gone afterwards) — verified on workerd/miniflare; production D1 documents the same atomicity.
- Path (B) `POST /api/invites/accept`: `already_member` (409, token not consumed) and a revoked token (`invite_invalid`) behave as specified; the same consumption batch is reused. Double-submit of a consumed token returns `invite_consumed` from `validateInvite` before the batch.
- The invite state travels only in the signed challenge cookie (`{ kind: "invite", uid, displayName, inviteId, spaceId }`); the cookie is ~400 bytes, and `register/verify` reads nothing but `response` / `deviceName` from the body. The cookie payload is re-validated with a zod discriminated union after signature verification, so an unknown `kind` is rejected even with a valid signature.
- Hono 4.13: a sub-app mounted with `protectedApi.route("/spaces/:spaceId", space)` whose `space.use("*", spaceMiddleware)` reads `c.req.param("spaceId")` gets the param populated (Hono merges sub-app routes into the parent with the prefixed path).
- drizzle-kit 0.31.10 emits `CHECK` constraints for SQLite when the schema declares them with `check(name, sql\`…\`)` from `drizzle-orm/sqlite-core` (array-form extra config), and local D1 enforces them (`CHECK constraint failed: space_members_role_check`). No hand-editing of the migration needed — `references/schema.md` now uses `check()`.
- Bootstrapping a drizzle-kit journal on a repo whose first migration was hand-written (`0000_init.sql` = `SELECT 1`): run `drizzle-kit generate --custom --name init` once against an **empty** schema file (creates `meta/0000_snapshot.json` + the journal entry, overwriting `0000_init.sql` — restore it from git), then `drizzle-kit generate --name <real>` against the real schema produces `0001_<real>.sql` with a consistent snapshot chain.
- "One owned space per user" (`POST /api/spaces`) is race-safe without a table lock: `INSERT INTO spaces … SELECT ?,?,? WHERE NOT EXISTS (SELECT 1 FROM space_members WHERE user_id = ? AND role = 'owner')` followed by the membership `INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM spaces WHERE id = ?)` in one batch; `meta.changes === 0` on the first statement → `409 already_owner`.

## Scope boundary — what this skill does NOT cover

- Passkey ceremonies, session cookies, `ChallengeState` / `issueChallenge` / `consumeChallenge`, `INITIAL_REGISTRATION_TOKEN`, credential management — `cloudflare-workers-passkey-auth` (this skill supplies the `worker/spaces/registration.ts` functions its `register/begin` / `verify` call: `validateInvite`, `registerInvitedUser`, `registerInitialUser`)
- Playwright wiring, virtual authenticator, seeded-session seam — `cloudflare-workers-e2e-playwright`
- The D1 `PRAGMA foreign_keys=OFF` rebuild trap and the backup / row-count runbook — `cloudflare-d1-drizzle-migration`
- Worker / wrangler / D1 skeleton — `cloudflare-workers-deploy-skeleton`
- Per-space R2 key prefixes for uploaded images (`<spaceId>/…`) — `cloudflare-r2-private-image-upload`
- Rate limiting the unauthenticated auth routes (invite validation rides on `register/begin`, which is rate-limited there) — `cloudflare-workers-bot-scan-defense`
- Roles beyond owner / member, per-space webhooks, multi-space switcher UX

## References

- [schema.md](references/schema.md) — Drizzle schema + generated SQL for `spaces` / `space_members` / `invites` and the domain-table rule
- [middleware.md](references/middleware.md) — `sessionMiddleware` membership resolution (`loadMemberSpaceIds`), dev-space auto-join (`ensureDevSpace`), `spaceMiddleware`, `requireOwner` / `isLastOwner`, router mounting, flat-URL alternative
- [invite-flow.md](references/invite-flow.md) — token helpers, `worker/spaces/registration.ts` (`validateInvite` / `registerInvitedUser` / `registerInitialUser`), `AuthError` additions, issue / list / revoke routes, paths (A) and (B) with the race-safe batch, client fragment handling
- [e2e-cross-space.md](references/e2e-cross-space.md) — fixed-UUID "other family" seed and the authorization-boundary spec
- [ops.md](references/ops.md) — family onboarding runbook, owner promotion, recovery, cleanup SQL
