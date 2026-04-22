---
name: cloudflare-d1-drizzle-migration
description: Safely run drizzle-kit migrations on Cloudflare D1 without losing data. Use when planning a drizzle migration that changes a column constraint (NULL → NOT NULL, type change, rename) or anything else that triggers a SQLite table rebuild. Covers the silent `PRAGMA foreign_keys=OFF` incompatibility that can cascade-delete child rows (a data-loss trap drizzle-kit defaults into), the phased NOT NULL column migration pattern (NULLABLE add → backfill → flip to NOT NULL) that works with a running production database, and the mandatory pre-deploy backup + post-deploy row count check runbook. Ends with 3 meta-level lessons that generalize beyond D1.
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets Cloudflare Workers with Drizzle ORM + drizzle-kit + D1 (SQLite). Requires wrangler CLI. Assumes you already have a working Cloudflare Workers skeleton — if not, see the `cloudflare-workers-deploy-skeleton` skill first.
metadata:
  author: okayus
  version: "0.1.0"
---

# Cloudflare D1 + Drizzle Migration Safety

**The core trap in one sentence**: drizzle-kit generates migrations that start with `PRAGMA foreign_keys=OFF;`, but Cloudflare D1 ignores this PRAGMA. If your migration rebuilds a table (e.g. NOT NULL 化), `DROP TABLE parent;` fires every `ON DELETE CASCADE` in child tables and deletes their rows silently. Local testing (miniflare SQLite) passes because miniflare respects the PRAGMA.

This skill exists because the author lost 1257 production rows to this exact trap. Don't repeat it.

## When to use this skill

- You're about to run `pnpm db:generate` that will change a column constraint on a D1 table
- You see `CREATE TABLE __new_*` + `DROP TABLE` in the generated migration SQL (i.e. a table rebuild)
- You're adding or modifying `onDelete: "cascade"` in a drizzle schema
- You're planning a live DB schema change on a deployed D1 database with real user data

Do **not** use for:
- Brand-new projects with zero production data (just re-create the DB)
- Pure additive migrations (new tables, new nullable columns, new indexes) — these don't rebuild tables
- Non-D1 SQLite deployments (the PRAGMA issue is D1-specific)

## Deliverables (completion criteria)

- [ ] Generated migration SQL reviewed before `--remote` apply
- [ ] Pre-deploy `wrangler d1 export --remote` backup saved to `backups/<date>-<summary>.sql` (gitignored)
- [ ] Post-deploy row count check on every child table that CASCADEs into the rebuilt parent
- [ ] If row counts dropped: immediate restore from backup using the extracted-INSERTs pattern
- [ ] For column constraint changes on tables with historical data: follow the phased NULLABLE → backfill → NOT NULL pattern, not a one-shot migration

## The D1 / drizzle-kit PRAGMA incompatibility (the core trap)

SQLite doesn't support `ALTER TABLE ... MODIFY COLUMN`. When you change a column constraint in a drizzle schema (e.g. `.notNull()` added), drizzle-kit emits the standard SQLite table-rebuild pattern:

```sql
PRAGMA foreign_keys=OFF;          -- ← D1 ignores this
CREATE TABLE __new_parent (...);  -- new table with the new constraints
INSERT INTO __new_parent SELECT * FROM parent;
DROP TABLE parent;                -- ← child CASCADE fires here on D1
ALTER TABLE __new_parent RENAME TO parent;
PRAGMA foreign_keys=ON;
CREATE INDEX ...;
```

On Cloudflare D1, the `PRAGMA foreign_keys=OFF` is silently ignored. `DROP TABLE parent;` triggers an implicit DELETE of all rows, which fires `ON DELETE CASCADE` on any child table with an FK pointing at the parent. You lose child data.

`PRAGMA defer_foreign_keys=TRUE` is honored by D1, but it only defers FK *violation checking* to commit time. It does NOT suppress CASCADE action firing. It's not a workaround for this problem.

For full diagnosis and detection steps, see [references/d1-drizzle-kit-pitfalls.md](references/d1-drizzle-kit-pitfalls.md).

## The mandatory pre-deploy runbook

Before `--remote` applying any drizzle migration that rebuilds a table:

1. **Backup**: `wrangler d1 export <db> --remote --output=backups/$(date +%F)-<summary>.sql`
2. **Audit schema for incoming CASCADEs**: `grep -n 'onDelete.*cascade' <schema.ts>` — any child table pointing at the table you're rebuilding?
3. **Inspect generated SQL**: open `drizzle/NNNN_*.sql` and confirm the `DROP TABLE <parent>` is present and which children would cascade
4. **Apply**
5. **Verify**: `SELECT COUNT(*) FROM <child>` for every child with a CASCADE FK. Compare to the count in the backup
6. **If counts dropped**: immediate restore via extracted INSERTs (see [references/runbook.md](references/runbook.md))

`backups/` must be gitignored — D1 exports contain user data.

For the fully-scripted version of this runbook with copy-ready commands, see [references/runbook.md](references/runbook.md).

## The phased NOT NULL column migration pattern

For live databases with historical rows that don't yet satisfy the new constraint, never run a one-shot migration. Split into **4 PRs** that can each be rolled back cleanly:

| PR | Change | Production impact |
|---|---|---|
| 1 | Add the new column as NULLABLE. Update middleware/domain types. Routes unchanged | Zero — no routes use the column yet |
| 2 | Bootstrap: manual SQL to backfill existing rows. Commit the SQL as a script file (`packages/<pkg>/scripts/<date>-<summary>.sql`) so there's a paper trail | DB-only, no code change |
| 3 | Routes start using the column (`WHERE` / `INSERT`). Add e2e for the new constraint. Update CLAUDE.md / docs | Behavior switches on |
| 4 | Flip the column to `NOT NULL` in schema → regenerate migration → this is the table-rebuild migration → **apply the runbook above** | Schema invariant locked |

This is what happens when the table you're flipping to NOT NULL is a parent with CASCADE FKs pointing into it: PR 4 is the dangerous one. The prior 3 PRs give you space to verify data is ready before the table-rebuild moment.

For the full walkthrough with example migration SQL per phase, see [references/phased-column-migration.md](references/phased-column-migration.md).

## Meta-level lessons

Beyond the mechanical runbook, three generalizable lessons. Keep these in your head when touching any migration or schema change, not just D1 ones. Full write-up in [references/lessons.md](references/lessons.md):

1. **Local-vs-production semantics parity is a hypothesis, not a guarantee.** "miniflare pass = D1 safe" is wrong for PRAGMA behavior, and analogous gaps exist in other stacks (sqlite vs Postgres; local Redis vs ElastiCache; Docker Postgres vs RDS). When touching migrations / PRAGMAs / transaction isolation, assume divergence until proven otherwise.

2. **E2E tests have a structural blind spot for destructive side-effects.** Tests create their own data, so "1257 historical rows got deleted" isn't something they check. Guard destructive operations with operational controls (backup + row count assertion), not tests.

3. **Design review must ask "what does this PR destroy?" not just "what does it build?"** The cascade was 1 line away in `schema.ts` (`toilet_records.catId.onDelete: "cascade"`). A 1-minute `grep onDelete schema.ts` before writing PR body would have caught it. Wire "what FK / WHERE / trigger does my change touch by cascade?" into PR planning templates.

## Scope boundary — what this skill does NOT cover

- Initial D1 + drizzle setup — use `cloudflare-workers-deploy-skeleton` first
- Backup strategy beyond pre-migration dumps (weekly snapshots, PITR) — different concern
- Schema design (when to use CASCADE vs RESTRICT vs NO ACTION) — covered briefly in lessons.md but not the main focus
- Migrating between D1 instances or Postgres → D1 conversions — out of scope

## References

- [runbook.md](references/runbook.md) — step-by-step pre/post deploy commands with copy-ready snippets (including the INSERT-extract restore recipe)
- [phased-column-migration.md](references/phased-column-migration.md) — the 4-PR NULLABLE → backfill → NOT NULL pattern with example SQL
- [d1-drizzle-kit-pitfalls.md](references/d1-drizzle-kit-pitfalls.md) — D1 / drizzle-kit incompatibilities, how to detect a table-rebuild migration from the generated SQL, and the `PRAGMA defer_foreign_keys` non-fix
- [lessons.md](references/lessons.md) — the 3 meta-level lessons in full, with examples of each generalizing to other stacks
