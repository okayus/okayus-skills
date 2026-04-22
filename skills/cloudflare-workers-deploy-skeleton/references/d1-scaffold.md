# D1 pipeline validation with empty migration

`wrangler d1 migrations apply` does nothing (and exits 0) when `migrations_dir` is empty. To prove the migration pipeline is actually wired, ship one throwaway migration that runs but creates nothing.

## `packages/web/drizzle/0000_init.sql`

```sql
-- Phase 1 skeleton: empty migration to validate the pipeline end-to-end.
-- Real schema is added in later phases (users, sessions, domain tables, etc.).
SELECT 1;
```

Alternatives that also work:
- `SELECT 0;`
- `-- intentionally empty` — but a no-op comment file generates no audit trail in the `d1_migrations` meta table. `SELECT 1` produces a row you can `wrangler d1 migrations list` and confirm `(Applied)`

## Why not just skip it

Without any migration file, CI's migrations-apply step becomes a silent no-op. You only discover the pipeline is broken the first time you ship a real schema change — months later, probably late at night. A dummy migration at skeleton stage proves:

1. `migrations_dir: "drizzle"` in `wrangler.jsonc` points to a real directory that the workflow can read
2. `CLOUDFLARE_API_TOKEN` has `D1:Edit` (missing D1:Edit fails here with HTTP 7403 — see gh-actions-template.md)
3. `database_id` in `wrangler.jsonc` is a real UUID and exists in your account

All three failure modes surface at skeleton deploy time, not 3 months later.

## Why defer `drizzle-kit` / `drizzle-orm`

It's tempting to install `drizzle-kit` now and add a `db:generate` script — but:

- `drizzle.config.ts` requires pointing at a `schema.ts` file
- You don't have `worker/db/schema.ts` yet
- Pointing `drizzle.config.ts` at a non-existent schema creates a Chekhov's gun (a referenced file that doesn't exist)
- Anyone running `pnpm db:generate` hits a confusing error

Install `drizzle-kit` + `drizzle-orm` the first time you actually need to generate a migration from a schema. Until then, hand-write `.sql` files in `drizzle/` with incrementing prefixes:

```
drizzle/
├── 0000_init.sql        # this skeleton
├── 0001_users.sql       # later
├── 0002_sessions.sql    # later
└── ...
```

Drizzle-kit is a migration **generator**, not a migration **applier**. `wrangler d1 migrations apply` is the applier. You can generate by hand indefinitely and only introduce Drizzle when schema complexity warrants it.

## Verifying after deploy

```bash
pnpm --filter @<scope>/web exec wrangler d1 migrations list <db-name> --remote
```

Expected:
```
┌──────────────────────────┬───────────────────────────┐
│ name                     │ created_at                │
├──────────────────────────┼───────────────────────────┤
│ 0000_init.sql            │ <UTC timestamp>           │
└──────────────────────────┴───────────────────────────┘
```

If the table is empty, migrations never applied in prod — check CI logs for the migrations step.
