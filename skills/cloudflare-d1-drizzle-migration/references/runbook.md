# Runbook: drizzle table-rebuild migration on D1

Step-by-step for safely applying a drizzle-generated migration that rebuilds a D1 table. Replace `<db>`, `<pkg>`, and paths with your project's values.

## 1. Before you write any schema change

Inventory what FKs point at the table you're about to modify:

```bash
grep -nE 'references\(\(\)\s*=>\s*<table>\.' <path>/schema.ts
grep -nE 'onDelete.*cascade' <path>/schema.ts
```

Any hit where `<table>` is the **parent** means a table-rebuild migration will trigger CASCADE deletes on D1. Proceed with the runbook below. If no CASCADE points at the table, you still want the backup step but the risk is lower.

## 2. Generate the migration and read it

```bash
pnpm db:generate
```

Open the new `drizzle/NNNN_*.sql`. You're in table-rebuild territory if you see:

```sql
PRAGMA foreign_keys=OFF;
CREATE TABLE `__new_<table>` (...);
INSERT INTO `__new_<table>`(...) SELECT ... FROM `<table>`;
DROP TABLE `<table>`;
ALTER TABLE `__new_<table>` RENAME TO `<table>`;
```

Confirm the new table's column definitions match your intent. Confirm the INSERT preserves every column you care about.

## 3. Record pre-migration row counts

For every child table with a CASCADE FK into the parent you're rebuilding:

```bash
pnpm exec wrangler d1 execute <db> --remote --json \
  --command "SELECT (SELECT COUNT(*) FROM <child>) AS <child>_count"
```

Save the numbers. You'll compare against these after.

## 4. Take a full backup

```bash
pnpm exec wrangler d1 export <db> --remote \
  --output="backups/$(date +%F)-pre-<summary>.sql"
```

Confirm the file isn't empty (`ls -lh backups/`) and grep the child table's INSERT lines are present:

```bash
grep -c '^INSERT INTO "<child>"' backups/<file>.sql
```

Commit `.gitignore` entry (if not already):

```gitignore
# D1 backups — contain user data, never commit
backups/
```

## 5. Apply the migration

Via your deploy workflow (preferred — atomic with the code change):

```bash
git push  # deploy.yml runs `wrangler d1 migrations apply <db> --remote`
```

Or manually if deploying out of band:

```bash
pnpm exec wrangler d1 migrations apply <db> --remote
```

## 6. Verify row counts immediately

Same SELECTs as step 3. Compare to saved numbers.

```bash
pnpm exec wrangler d1 execute <db> --remote --json \
  --command "SELECT COUNT(*) AS n FROM <child>"
```

If counts match → done.

If counts dropped → go to step 7 **immediately**. Every minute of delay is a minute of potential double-write divergence.

## 7. Restore from backup (if step 6 showed loss)

Extract just the INSERT statements for the lost child table:

```bash
grep '^INSERT INTO "<child>"' backups/<date>-pre-<summary>.sql > backups/restore-<child>.sql
wc -l backups/restore-<child>.sql   # sanity check: count matches pre-migration
```

Apply:

```bash
pnpm exec wrangler d1 execute <db> --remote --file backups/restore-<child>.sql
```

Verify:

```bash
pnpm exec wrangler d1 execute <db> --remote --json \
  --command "SELECT COUNT(*) AS n FROM <child>"
```

Should match the pre-migration count. If the FK references (e.g. `<child>.parent_id`) still resolve to rows in the rebuilt parent (normal case — parent rebuild preserves IDs), the restored INSERTs satisfy FK constraints and succeed.

## 8. Document the incident (if you restored)

Don't let a silent near-miss vanish into git history:

- Add an `Addendum` section to the ADR that drove the migration
- Update CLAUDE.md / AGENT.md with a runbook reference so the next session doesn't repeat
- Bump the version of this skill if the write-up revealed a new pitfall

## Copy-ready one-liners

Pre-migration backup:

```bash
pnpm exec wrangler d1 export <db> --remote --output="backups/$(date +%F)-pre-<summary>.sql"
```

Post-migration count check (single query for multiple children):

```bash
pnpm exec wrangler d1 execute <db> --remote --json --command \
  "SELECT (SELECT COUNT(*) FROM <child1>) AS c1, (SELECT COUNT(*) FROM <child2>) AS c2"
```

Restore from backup:

```bash
grep '^INSERT INTO "<child>"' backups/<backup>.sql \
  > backups/restore-<child>.sql \
  && pnpm exec wrangler d1 execute <db> --remote --file backups/restore-<child>.sql
```
