---
name: cloudflare-d1-weekly-backup-via-pr
description: Set up an automated weekly Cloudflare D1 backup workflow via GitHub Actions that exports the production database and opens a pull request adding the backup file to the repo. Covers the GitHub Actions "create-pull-request not permitted" gotcha that breaks every fresh repo's first PR-creating workflow, the cron schedule timezone conversion (UTC vs JST), the wrangler d1 export path-relativity quirk in monorepos, the explicit decision to track backups in git (with the failure modes that lead to it), and the existing CLOUDFLARE_API_TOKEN reuse pattern (no new secrets required).
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets Cloudflare D1 + GitHub Actions + pnpm monorepos. Requires a deployed Workers project with a working `CLOUDFLARE_API_TOKEN` secret already configured for deploys (extends the same token's permission scope). Uses `peter-evans/create-pull-request@v7` action.
metadata:
  author: okayus
  version: "0.1.0"
---

# Cloudflare D1 weekly backup via auto-opened PR

**The shape in one sentence**: a GitHub Actions workflow runs `wrangler d1 export --remote` on a weekly cron, writes the SQL dump to a path in the repo, and opens a pull request adding it. You review the diff (size, table counts) and merge. The file becomes a recovery source if credentials or data are lost.

This skill exists because every personal-scale Cloudflare project eventually wants a "yes, my data is backed up somewhere" answer, but most existing how-tos punt on the gritty parts: the GitHub Actions PR-permission default that blocks the first run, the path mess in monorepos, and the explicit "yes, commit the SQL to git" decision that needs justification.

## When to use this skill

- You have a deployed Cloudflare Workers + D1 app with real (non-throwaway) data
- You want a backup story that's automated, reviewable, and self-restoring (the SQL is `wrangler d1 execute --file`-ready)
- You're OK committing the dump to git (private repo, sub-100 MB / year, no PII regulations beyond your own care)
- You don't want to set up R2 / S3 / external storage for backups yet
- You don't yet have a backup workflow at all (this is the first one)

Do **not** use for:
- Public repos (don't commit user data publicly)
- Apps with regulated PII / GDPR / HIPAA requirements (need encrypted-at-rest storage with proper access logging, not git)
- Multi-GB databases (git-LFS adds friction; switch to R2)
- Projects that already have a working backup pipeline (don't migrate without reason)

## Deliverables (completion criteria)

- [ ] `.github/workflows/backup.yml` committed with weekly `cron` trigger + `workflow_dispatch` for manual runs
- [ ] First `workflow_dispatch` invocation succeeds and opens a PR adding `backups/<dated>.sql`
- [ ] Backup PR diff manually reviewed (file size sane, key tables present) and merged
- [ ] `backups/` removed from `.gitignore` if it was there (with a clear commit message explaining the policy reversal)
- [ ] Existing `CLOUDFLARE_API_TOKEN` secret confirmed to have `Account / D1 : Edit` scope (likely already does if deploys work)
- [ ] Repo setting "Allow GitHub Actions to create and approve pull requests" enabled (the most-skipped step — see Trap 1)

## Trap 1: GitHub Actions can't create PRs by default

Every fresh GitHub repo defaults to **blocking GH Actions from creating or approving pull requests**. Your `peter-evans/create-pull-request@v7` step will fail with:

```
##[error]GitHub Actions is not permitted to create or approve pull requests.
```

This is a repo-level setting, not a workflow YAML thing. The `permissions:` block in the workflow (which you also need — see Trap 2) controls what the GITHUB_TOKEN can do; the repo setting is a second, independent gate.

**Fix via web UI**: Settings → Actions → General → Workflow permissions → "Allow GitHub Actions to create and approve pull requests"

**Fix via CLI** (faster, scriptable):

```bash
gh api -X PUT repos/<owner>/<repo>/actions/permissions/workflow \
  -F default_workflow_permissions=read \
  -F can_approve_pull_request_reviews=true
```

Verify after:

```bash
gh api repos/<owner>/<repo>/actions/permissions/workflow
# expect: {"default_workflow_permissions":"read","can_approve_pull_request_reviews":true}
```

This is one-time per repo. Document the setting flip in your project's "operational backlog" doc so a future repo migration / clone doesn't lose it.

See [references/gh-actions-create-pr-permission.md](references/gh-actions-create-pr-permission.md) for the full diagnosis and an explanation of why this default exists (security-by-default reasoning) and why flipping it is fine for personal-scale repos.

## Trap 2: workflow `permissions:` block

Even with the repo setting flipped, the workflow's GITHUB_TOKEN needs explicit permissions:

```yaml
jobs:
  backup:
    runs-on: ubuntu-latest
    permissions:
      contents: write       # to commit the backup file to a new branch
      pull-requests: write  # to open the PR
```

The default `permissions:` for a workflow is read-only on most events. `peter-evans/create-pull-request@v7` needs both `contents: write` (to push the branch) and `pull-requests: write` (to open the PR). Forgetting either causes the action to fail; the error message points at whichever it tried first.

## The wrangler d1 export path quirk

In a pnpm monorepo with the Workers app at `packages/<pkg>/`, the natural way to invoke wrangler is via pnpm filter:

```bash
pnpm --filter @your/pkg exec wrangler d1 export <db-name> --remote --output <path>
```

The `--filter` changes wrangler's cwd to `packages/<pkg>/`, so the `--output` path is **relative to that directory**, not the repo root. If your `backups/` lives at the repo root, you need to escape:

```bash
pnpm --filter @your/pkg exec wrangler d1 export <db-name> \
  --remote \
  --output ../../backups/backup-weekly-${DATE}.sql
```

The `../../` is unintuitive. Document it inline:

```yaml
# backups/ is at the repo root. Inside `pnpm --filter`, cwd becomes
# packages/<pkg>/, so the output path needs ../../backups/.
```

Alternative: invoke wrangler directly from repo root with `cd`. Slightly cleaner but loses the pnpm-orchestrated install hierarchy. Pick one style and stay consistent with the rest of your workflows.

## The cron schedule (UTC vs JST)

GitHub Actions cron is **UTC always**. There's no timezone option. To translate:

| Desired local fire time | UTC cron |
|---|---|
| Sunday 12:00 JST (UTC+9) | `0 3 * * 0` |
| Sunday 03:00 PT (UTC-7 in summer, UTC-8 winter) | use `0 10 * * 0` and accept DST drift |
| Monday 09:00 UTC | `0 9 * * 1` |
| Daily at 04:00 UTC (server-friendly low-traffic) | `0 4 * * *` |

For a weekly backup, time-of-day matters less than predictability. Picking a Sunday morning UTC slot tends to be quiet on the platform side. Add a comment with the human-readable equivalent so you don't have to reverse-translate later:

```yaml
on:
  schedule:
    - cron: '0 3 * * 0'  # UTC Sun 03:00 = JST Sun 12:00
  workflow_dispatch:       # always include for manual runs / first-time setup
```

**Always include `workflow_dispatch`** on backup workflows. You'll need it for the first run (to verify everything works without waiting a week) and for ad-hoc backups before risky operations.

## Why commit backups to git (the explicit decision)

A common starting position is `backups/` in `.gitignore` — "data files don't belong in git". That's defensible but commits you to building separate backup infrastructure. For personal-scale projects (a few users, sub-MB weekly dumps), tracking backups in git is a pragmatic choice with these properties:

- **Versioned automatically** (git history = backup history)
- **Reviewable as PRs** (size diff visible, suspicious zero-row backups blockable)
- **Restorable with one command** (`wrangler d1 execute --remote --file backups/<date>.sql`)
- **No new infrastructure** (no R2 bucket, no S3 IAM, no encryption key management)

Trade-offs to accept explicitly:
- Repo size grows. At ~50 KB/week that's ~2.5 MB/year. Acceptable until ~5 years; migrate before then if needed.
- Backup quality is gated on someone reviewing/merging the PR. If nobody merges for 3 weeks, you have stale backups. Set a Slack/Discord reminder if this becomes a real problem.
- Private repo only. Don't publish backups to a public repo.

If your project starts with `backups/` in `.gitignore` and you decide to commit, **explicitly remove the line and explain in the commit message** so the next person reading git history doesn't think it was an accident:

```
chore(gitignore): track backups/ in git

Phase N decision: weekly D1 backups go in `backups/` as SQL dumps
in the repo. Trade-off accepted: ~2.5 MB/year repo growth in exchange
for git-managed versioning and PR-reviewable diffs. Revisit when repo
crosses ~50 MB or if any user data classification changes.
```

See [references/backup-vs-gitignore-decision.md](references/backup-vs-gitignore-decision.md) for the full rationale and what triggers re-evaluating.

## CLOUDFLARE_API_TOKEN scope

Reuse the existing token from your deploy workflow if it has `Account / D1 : Edit`. Most deploy tokens do (it's needed for `wrangler d1 migrations apply`). Confirm by:

```bash
# In the workflow run log, the export step should succeed without "Authentication error 7403"
```

If you get 7403 from `wrangler d1 export`, the token is missing `D1 : Edit`. Generate a new token with the scope and update the repo secret. Don't use a separate token for backups — operational simplicity matters more than scope minimization for personal-scale projects.

## The full workflow YAML

See [references/workflow-yml-template.md](references/workflow-yml-template.md) for a copy-ready `.github/workflows/backup.yml` with all the gotchas already addressed (permissions block, path escapes, cron + workflow_dispatch, peter-evans config with appropriate labels).

## First-run procedure

1. Commit `.github/workflows/backup.yml` (and `.gitignore` reversal if applicable). Merge.
2. Flip the repo setting (Trap 1): `gh api -X PUT repos/$repo/actions/permissions/workflow -F default_workflow_permissions=read -F can_approve_pull_request_reviews=true`
3. Trigger manually: `gh workflow run "<workflow-name>"`
4. Watch the run: `gh run watch` (or `gh run view <id>`)
5. When green, find the auto-opened PR: `gh pr list --label backup`
6. Review the diff (file size sane, expected tables present, no obvious data loss)
7. Merge

After this, the cron fires weekly and you only do step 6 + 7 each Sunday.

## Restore procedure (when you need it)

Inverse of export — `wrangler d1 execute` with `--file`:

```bash
# DESTRUCTIVE — wipes current data. Use with care.
wrangler d1 execute <db-name> --remote --file backups/backup-weekly-<date>.sql
```

For partial restores (e.g., recovering one user's credentials after a corruption incident), grep the relevant `INSERT` statements out of the SQL dump and run them via `--command`:

```bash
grep "INSERT INTO credentials" backups/backup-weekly-2026-04-23.sql | \
  grep "<user-id>" | \
  xargs -I{} wrangler d1 execute <db-name> --remote --command "{}"
```

(Be careful with quoting; for production use, dry-run on `--local` first.)

## Scope boundary — what this skill does NOT cover

- Pre-migration backup runbooks (different cadence, ad-hoc) — see `cloudflare-d1-drizzle-migration` skill
- Real-time replication / point-in-time recovery — out of scope; D1 doesn't natively support PITR yet
- Encrypting backups at rest — if you need this, you've outgrown commit-to-git anyway; switch to R2 with KMS
- Restoring to a different D1 database (test environment from prod) — possible but adds quoting nuances; future skill if it becomes common
- Cron timezone management for non-UTC schedules with DST — accept the drift, or use a timezone-stable midnight UTC slot

## References

- [references/workflow-yml-template.md](references/workflow-yml-template.md) — the full backup.yml file with inline comments
- [references/gh-actions-create-pr-permission.md](references/gh-actions-create-pr-permission.md) — the repo setting trap, why it exists, how to flip it
- [references/backup-vs-gitignore-decision.md](references/backup-vs-gitignore-decision.md) — when committing backups to git is right, when to migrate to R2/S3
