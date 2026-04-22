# GitHub Actions `deploy.yml` template

Auto-deploys on `main` push with D1 migrations applied before the Worker deployment.

## `.github/workflows/deploy.yml`

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:

concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: false

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 9.15.0
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Apply D1 migrations (remote)
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: pnpm --filter @<scope>/web exec wrangler d1 migrations apply <db-name> --remote
      - name: Build and deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: pnpm --filter @<scope>/web run deploy
```

## Critical ordering: migrations first, deploy second

The migration step **must run before** `wrangler deploy`. If you deploy new code that expects a new column and then migrate, there's a window where requests hit the new Worker with the old schema and return 500s.

Reverse this ordering and you create a time-of-check vs time-of-use race on every schema change.

## `concurrency` settings explained

- `group: deploy-${{ github.ref }}` — one in-flight deploy per branch
- `cancel-in-progress: false` — **don't cancel a running deploy** when a new commit lands. Canceling mid-run can leave migrations applied but the Worker not yet deployed (or vice versa). Let each deploy complete end-to-end

## Secret requirements

Set via `gh secret set`:

| Secret | Source | Scope |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Phase 1.3 of setup-order.md — `Workers Scripts:Edit + D1:Edit + Account Settings:Read + User Details:Read` | Account |
| `CLOUDFLARE_ACCOUNT_ID` | Dashboard right sidebar | Account |

**The "Edit Cloudflare Workers" token template lacks `D1:Edit`** — adding D1:Edit manually is the single most-often-missed step. Symptom: CI fails on the migrations step with HTTP 7403.

## Using `pnpm run deploy` (not `pnpm deploy`)

`pnpm deploy` is a built-in pnpm subcommand that does something entirely different (publishes a package). In the workflow, use either:

- `pnpm --filter @<scope>/web run deploy` (recommended in CI)
- `pnpm --filter @<scope>/web exec wrangler deploy`

Both work; the first invokes the npm-script `deploy` defined in `packages/web/package.json`.

## Optional enhancements (defer to later phases)

Things to NOT add at skeleton stage but to consider later:

- Post-deploy smoke test step (`curl /health` and fail if non-200)
- Preview environments per PR
- Rollback helper workflow (manual dispatch with deployment ID)
- Deploy failure notifications (Slack / Discord)
- Branch protection rule requiring `deploy` to be green before merge
