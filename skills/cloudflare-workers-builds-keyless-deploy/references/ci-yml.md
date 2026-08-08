# Secrets-free CI workflow (`.github/workflows/ci.yml`)

Deployment is Workers Builds' job (Cloudflare side), so GitHub Actions keeps only
test/lint/typecheck and **zero secrets**. The job id `ci` is what the branch ruleset
requires — keep them in sync.

```yaml
# test/lint/typecheck only. Deploys are done by Workers Builds (Cloudflare side) =
# no Cloudflare secret exists in this repo's Actions (see ADR/secrets strategy).
# The main ruleset requires this workflow's job name `ci` as a status check.
name: CI

on:
  pull_request:
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  ci:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6   # no `version:` — it reads packageManager from package.json
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - name: Typecheck
        run: pnpm -r run check
      - name: Build
        run: pnpm -r run build
      # add `pnpm -r run test` / `lint` once those scripts exist
```

Notes:

- `on: pull_request` is what attaches the required check to PRs. PRs opened by a
  GitHub App token (e.g. a host-side relay) trigger this normally — unlike
  `GITHUB_TOKEN`-created PRs, which get stuck behind a manual "Approve workflows
  to run" gate (GitHub behavior current as of 2026-06).
- `push: branches: [main]` gives main a post-merge signal too (and validates the
  workflow on the very first push, before any PR exists).
- Renaming the `ci` job id breaks the ruleset's required check — it matches by
  check-run name.
