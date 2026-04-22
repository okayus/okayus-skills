# D1 / drizzle-kit pitfalls

Known incompatibilities between what drizzle-kit generates and how Cloudflare D1 actually behaves.

## 1. `PRAGMA foreign_keys=OFF` is silently ignored by D1

**Symptom**: A drizzle-generated migration that rebuilds a table (CREATE `__new_*` → INSERT SELECT → DROP old → RENAME) runs successfully on D1, but child tables with `ON DELETE CASCADE` FKs pointing at the rebuilt table are emptied.

**Why it happens**: drizzle-kit prefixes its table-rebuild migrations with `PRAGMA foreign_keys=OFF;` (standard SQLite pattern). Cloudflare D1 doesn't honor this PRAGMA — foreign key enforcement stays ON regardless. `DROP TABLE parent;` in D1 performs an implicit `DELETE FROM parent;` first, which fires every incoming `ON DELETE CASCADE` and wipes the child rows.

**Local testing doesn't catch this**: miniflare (the SQLite used by `wrangler dev` and local `wrangler d1 execute --local`) respects `PRAGMA foreign_keys=OFF`. So the same migration that silently deletes child data in production works fine in local tests.

**The "obvious" workaround that doesn't work**: `PRAGMA defer_foreign_keys=TRUE` *is* honored by D1, but its semantics are different. `defer_foreign_keys` delays FK *violation checking* until transaction commit, so you can temporarily have dangling references within the transaction. It does **not** suppress `ON DELETE CASCADE` action firing — cascades still execute when the parent row is deleted.

**The actual workaround**:

1. **Accept the cost**: backup before migration + row count check after (see [runbook.md](runbook.md))
2. **Remove CASCADE before rebuild**: split into a 3-PR dance — (a) demote child's `onDelete: "cascade"` to `"no action"`, (b) do the parent rebuild, (c) re-promote to `"cascade"`. Each of those is itself a table rebuild though, so you've multiplied the work — only worth it if child data is very large and very valuable

## 2. Detecting whether a migration will rebuild a table

Check the generated `drizzle/NNNN_*.sql` for any of these patterns:

```sql
CREATE TABLE `__new_<name>` (
ALTER TABLE `__new_<name>` RENAME TO `<name>`
DROP TABLE `<name>`
```

If present → it's a table rebuild. Apply the runbook.

Triggers for drizzle-kit to emit a rebuild:

- Adding/removing `.notNull()` on an existing column
- Changing a column's type
- Adding or modifying a PRIMARY KEY / UNIQUE constraint
- Adding `.references()` to an existing column (new FK)
- Changing `onDelete` / `onUpdate` behavior on an existing FK
- Renaming a column (though drizzle-kit may prompt for this and use RENAME directly)

Triggers that are safe (additive):

- `ADD COLUMN` with no constraints or with a default — uses `ALTER TABLE ADD`, not a rebuild
- `CREATE INDEX` — no table touch
- New tables entirely
- Adding a new NULLABLE `.references()` column at the same time as the column (wait — does this rebuild? verify on a spike)

Always read the generated SQL before trusting a classification.

## 3. `PRAGMA foreign_keys=OFF` limitation → avoid CASCADE on high-value children in the first place

If you're designing a schema and considering `onDelete: "cascade"` on a child table with lots of historical data, weigh:

- Pro: automatic cleanup on parent delete
- Con: **any future parent table rebuild deletes the child**; backup/restore dance becomes mandatory forever

Alternatives:

- `onDelete: "no action"` + application-level cascade on parent delete (explicit DELETE before the parent DELETE, same transaction)
- `onDelete: "restrict"` + fail-loud if child rows exist. Forces explicit cleanup before parent deletion
- `onDelete: "set null"` if the child can logically exist without the parent

For nyalog-style "records belong to cat, cat delete → records gone" semantics, `cascade` is correct domain behavior. Just be aware of the migration cost.

## 4. `wrangler d1 export --remote` is the only reliable backup

D1 doesn't offer point-in-time restore at the time of writing. `wrangler d1 export` is your escape hatch. Three things to know:

- The export file is a SQL dump with `CREATE TABLE` + `INSERT INTO "<table>"` (note the double-quotes around table name — some greps need to account for that)
- Exports include the `d1_migrations` tracking table — useful if you need to inspect migration history, but don't re-import it blindly
- Exports can take several seconds for non-trivial databases. For a 1 MB DB, expect ~5 sec; for 100 MB, a few minutes. Plan accordingly if you're running backup inside a timed window

For the extract-child-INSERTs-from-backup pattern, see [runbook.md](runbook.md) step 7.

## 5. The `backups/` directory should never be committed

D1 exports contain every row. For consumer-facing apps that means PII. Always:

```gitignore
# D1 exports — contain user data
backups/
```

And make sure no one committed the backups before this line was added:

```bash
git log --all --full-history -- backups/  # should be empty
git log --all --full-history -- '**/*.sql' | grep -i export  # sanity check for accidentally-named exports elsewhere
```
