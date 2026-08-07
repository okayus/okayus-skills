# Commit backups to git, or not? An explicit decision

## The default starting position

Most repo `.gitignore` templates include some form of `data/` or `backups/` exclusion. The reasoning is sound: data files don't belong in source code repos. They're large, they change often (so diffs are huge), they may contain user PII, and committing them blurs the line between code and data.

For most repos, this default is correct. For a small subset of personal-scale projects, committing backups to git is actually the right pragmatic choice. This document is for deciding which side you're on.

## When committing to git is the right call

### Project shape

- Single-developer or 2-3 person team
- Private repo (always — never commit user data publicly)
- Sub-MB weekly backups (i.e., low-traffic app, single-digit users)
- No regulatory PII / GDPR / HIPAA constraints beyond "I personally care about not leaking my own data"
- Database is small enough that a full SQL dump compresses to <100 KB / week
- Project lifetime expected at most ~5 years before re-architecture

### Properties you get

- **Versioning is automatic** — git history = backup history, with timestamps and reviewable diffs
- **Reviews catch corruption** — opening a PR forces a human to look at the diff. Zero-row backups (silent export failure) are visible. Massive size jumps (data ingestion bug) are visible.
- **Restore is one command** — `wrangler d1 execute --remote --file backups/<file>.sql`
- **No new infrastructure** — no R2 bucket, no S3 IAM, no encryption key management, no rotation policy
- **No cost** — GitHub private repos with this volume are free
- **Lives where the code lives** — if you have the repo, you have the recovery path

### What the trade-off looks like at scale

For a 50 KB / week backup over 5 years:
- 50 KB × 52 × 5 = ~13 MB total
- git operations stay fast (push/pull/clone all sub-second)
- diffs are reviewable (a 50 KB SQL file is ~1000 lines, scannable in 30 seconds)

This is the "personal hobby project" sweet spot.

## When to migrate to R2 / S3 / external storage

### Triggers

- **Repo size crosses ~50 MB** — `git clone` starts taking visibly long, GitHub UI starts complaining
- **Backup files cross ~5 MB each** — diffs are no longer reviewable; you're rubber-stamping merges
- **User count grows** — more data means more PII concentration; commit-to-git starts feeling reckless
- **Regulatory shift** — GDPR data subject deletion requests become hard if backups are in git history (`git rm` doesn't actually remove from history without rewrite)
- **Multi-developer team** — someone will accidentally clone the repo to a less-trusted location

### Migration target options

| Target | Pros | Cons |
|---|---|---|
| Cloudflare R2 | Same cloud as your D1, no egress fees within Cloudflare | Need to set up bucket + lifecycle policy + access key |
| AWS S3 + Glacier | Cheap long-term storage, lifecycle automation | Different cloud (egress costs to Cloudflare); IAM complexity |
| GitHub Actions artifacts | Free, easy to wire from existing workflow | Default 90-day retention (private repos can raise it to 400 days), not designed as a primary backup store |
| Self-hosted / NAS | Full control | You're now operating storage infrastructure |

For a project graduating from commit-to-git, **R2** is the natural next step (same cloud, simple S3-compatible API, no egress fees from Workers / Actions in the same network).

### The migration itself

You don't need to migrate old backups. Stop committing new ones (re-add `backups/` to `.gitignore`), set up R2 upload, and treat the existing git-tracked backups as the historical record up to the cutover date. Going forward, R2 is the live backup store.

```yaml
# In the new workflow, replace the create-pull-request step with:
- name: Upload to R2
  env:
    AWS_ACCESS_KEY_ID: ${{ secrets.R2_ACCESS_KEY }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_SECRET_KEY }}
    AWS_DEFAULT_REGION: auto
  run: |
    aws s3 cp backups/backup-weekly-${DATE}.sql \
      s3://<your-bucket>/backups/backup-weekly-${DATE}.sql \
      --endpoint-url https://<account-id>.r2.cloudflarestorage.com
```

Re-add `backups/` to `.gitignore` after the cutover.

## How to commit to the decision visibly

Your `.gitignore` and the project's docs should make the choice traceable.

### `.gitignore`

If you're starting from scratch and committing to git:

```
# Backups are tracked in git (private repo, sub-MB weekly).
# Revisit if repo crosses ~50 MB or user data classification changes.
# (No backups/ exclusion intentionally.)
```

If you're reversing a prior `backups/` ignore:

```
# (commented out) backups/  # tracked since YYYY-MM-DD — see <ADR-0XXX>.md
```

### Commit message for the policy change

```
chore(gitignore): track backups/ in git

Phase N decision: weekly D1 backups go in `backups/` as SQL dumps in
the repo. Trade-off accepted: ~2.5 MB/year repo growth in exchange
for git-managed versioning and PR-reviewable diffs.

Migration triggers:
- Repo size crosses ~50 MB
- Per-backup file crosses ~5 MB
- User data classification changes (regulated PII added)

Revisit when any trigger fires. See `references/backup-vs-gitignore-decision.md`
for the full rationale.
```

### ADR (if your project uses ADRs)

A short ADR is overkill for personal projects but useful at the 3-developer / professional context. Capture the four questions:
1. Why this decision now?
2. What alternatives were considered?
3. What conditions reverse the decision?
4. Who reviews the trigger conditions, and how often?

## Generalizable lesson

**"Don't commit data" is a default rule, not an absolute one.** Defaults exist for the median case; some specific cases are atypical enough to warrant deviation. The mistake is deviating without making the deviation visible — future contributors won't understand why and either silently revert or silently extend the deviation past its intended scope.

Whenever you break a default, leave a paper trail: a comment, a commit message, an ADR. The cost is 5 minutes; the value is the next contributor (often future-you) understanding the boundary.

This applies broadly: TypeScript `any` casts, eslint-disable comments, retry-with-backoff that's actually retrying-the-wrong-thing, hardcoded timeouts, the list goes on. **The act of explaining the deviation is what makes it sustainable.**
