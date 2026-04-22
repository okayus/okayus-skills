# Phased column-constraint migration (NULLABLE → backfill → NOT NULL)

For live databases where existing rows don't yet satisfy a new constraint (typically `NOT NULL` on a newly added column, or a new FK reference), split the work into 4 PRs. Each is independently reviewable and rollbackable.

This pattern assumes a single-Worker + D1 stack with auto-deploy on main push. Adjust the phase boundaries if your deploy cadence differs.

## Phase 1: schema + middleware addition (NULLABLE)

**Goal**: Add the new column and make its value available at runtime, without any routes using it yet.

Schema change:

```typescript
// packages/<pkg>/worker/db/schema.ts
export const <parent> = sqliteTable("<parent>", {
  id: text("id").primaryKey(),
  // ... existing columns ...
  newCol: text("new_col"),  // NULLABLE — we'll flip to .notNull() in Phase 4
});
```

Middleware (if the new column is an authz / routing axis):

```typescript
c.set("newColValue", await loadNewColValue(db, c.var.userId));
```

Generate and apply migration:

```bash
pnpm db:generate   # emits ALTER TABLE <parent> ADD <new_col> text
pnpm db:migrate    # local
git push           # CI applies --remote
```

This is a pure additive migration — no table rebuild, no CASCADE risk. Production behavior unchanged because routes don't read the column yet.

**Test plan for the PR**: existing e2e still passes; `SELECT COUNT(*) FROM <parent> WHERE new_col IS NULL` = total count (nothing backfilled yet).

## Phase 2: backfill (manual SQL, no code change)

**Goal**: Every existing row gets a non-NULL value for the new column.

Write the backfill SQL as a commit-tracked script:

```sql
-- packages/<pkg>/scripts/YYYY-MM-DD-<summary>.sql
UPDATE <parent> SET new_col = '<computed value>' WHERE new_col IS NULL;
```

If the value comes from a JOIN or lookup, use a CTE:

```sql
UPDATE <parent>
SET new_col = (SELECT <col> FROM <lookup> WHERE <lookup>.id = <parent>.lookup_id)
WHERE new_col IS NULL;
```

Execute:

```bash
pnpm exec wrangler d1 execute <db> --remote --file packages/<pkg>/scripts/<file>.sql
```

Verify:

```bash
pnpm exec wrangler d1 execute <db> --remote --json \
  --command "SELECT SUM(CASE WHEN new_col IS NULL THEN 1 ELSE 0 END) AS still_null FROM <parent>"
# expected: still_null = 0
```

**PR body**: include the before/after counts, the SQL being run, and the rationale for the chosen backfill value. Committing the script file even though it's a one-shot execution gives you a paper trail for future reviewers.

**Test plan**: no code changed, so no e2e changes. Manual SELECT verification is the test.

## Phase 3: routes + e2e (column becomes load-bearing)

**Goal**: Switch routes / business logic to use the new column. Add the test that proves the column is now doing its job.

```typescript
// routes
const rows = await db.select().from(<parent>)
  .where(and(eq(<parent>.id, id), eq(<parent>.newCol, expectedValue)));
```

For authz axes: ensure the WHERE includes the new column on every SELECT / UPDATE / DELETE.

E2E test (style depends on project, but aim for one scenario that would fail if the column WHERE were removed):

```typescript
test("the new constraint is enforced", async ({ page }) => {
  // attempt cross-boundary access via direct API call
  const res = await page.request.get(`/api/<resource>/<foreign-id>`);
  expect(res.status()).toBe(404);  // or 403 per your policy
});
```

Update CLAUDE.md / docs with the new invariant.

**This is the PR that flips production behavior.** After merge, a new class of requests will return 404/403 where they previously returned 200. If your app depended on the old behavior anywhere (it shouldn't, if Phase 2 backfilled correctly), this is where you find out.

**Test plan**: new e2e test passes; all existing e2e still passes; production user scenarios still work (manual verification post-deploy).

## Phase 4: NOT NULL flip (the dangerous one)

**Goal**: Lock the schema invariant. After this PR, the DB rejects any INSERT without a value for the column.

Schema change:

```typescript
newCol: text("new_col").notNull(),
```

If the column is an FK:

```typescript
newCol: text("new_col")
  .notNull()
  .references(() => <target>.id, { onDelete: "cascade" }),
```

Generate the migration and **read it carefully**:

```bash
pnpm db:generate
```

You'll see the table-rebuild pattern:

```sql
PRAGMA foreign_keys=OFF;
CREATE TABLE `__new_<parent>` (..., new_col text NOT NULL, ...);
INSERT INTO `__new_<parent>` SELECT ... FROM <parent>;
DROP TABLE `<parent>`;
ALTER TABLE `__new_<parent>` RENAME TO `<parent>`;
...
```

**Now apply the runbook** in [runbook.md](runbook.md) — specifically steps 3 (record child counts), 4 (backup), 5 (apply), 6 (verify counts), 7 (restore if needed).

### Why Phase 4 is the dangerous one

On D1, `DROP TABLE <parent>` fires every incoming `ON DELETE CASCADE`. If `<child>.parent_id` has `onDelete: "cascade"`, `<child>` will be emptied during the rebuild even though `PRAGMA foreign_keys=OFF` is in the generated SQL (D1 ignores the PRAGMA). The Phase 1-3 work doesn't help here — this is a structural SQLite-table-rebuild issue.

If the audit in runbook.md step 1 found incoming CASCADEs, you have two options:

- **Option A**: Accept the backup + verify + restore runbook. Cheap if child row count is small, reliable if you actually run the verification step
- **Option B**: Temporarily demote the child's `onDelete: "cascade"` to `"no action"` in a separate PR *before* Phase 4, then re-promote in a separate PR *after*. More ceremony, but no data loss risk

For most small-app projects, Option A is pragmatic. Just actually run the verification.

## Rollback strategy per phase

| Phase | Rollback cost |
|---|---|
| 1 | Drop the column via new migration. No data touched |
| 2 | `UPDATE <parent> SET new_col = NULL WHERE new_col = '<value>'`. Trivial |
| 3 | Revert the code PR. Column still populated, just not used |
| 4 | If caught fast: restore from backup using runbook.md step 7. Schema itself cannot be un-rebuilt cheaply; you'd need another migration to restore NULL-ability |

Plan deploy windows accordingly: Phase 4 is the one to schedule when you have attention available for the post-deploy check.
