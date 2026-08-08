---
name: cloudflare-workers-builds-keyless-deploy
description: Deploy Cloudflare Workers from GitHub with ZERO Cloudflare credentials stored in GitHub (no CLOUDFLARE_API_TOKEN in Actions secrets), using Workers Builds — Cloudflare's git-connected CI/CD. Use when setting up or migrating a Workers project so that an autonomous agent pipeline never holds a Cloudflare secret, or when asked "can we deploy without a CF API token in CI". Covers the traps that cost hours — the default build token lacking D1 Edit (migrations fail with an auth error that never names the cause), Root directory hiding in the Advanced settings accordion, preview builds sharing the PRODUCTION D1 database, Workers Builds NOT waiting for GitHub CI (gate with a branch ruleset instead), telling a build that never triggered (missing Workers Builds check-run) from one that failed, and skipping docs-only deploys with build watch paths.
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets Cloudflare Workers (wrangler.jsonc) + D1 + pnpm monorepos, GitHub repos. Requires gh CLI for ruleset setup; dashboard access for the one-time ceremony.
metadata:
  author: okayus
  version: "0.2.0"
---

# Cloudflare Workers Builds: Keyless Deploy

Replace "GitHub Actions runs `wrangler deploy` with a `CLOUDFLARE_API_TOKEN` secret" with **Workers Builds**: Cloudflare pulls the repo via its GitHub App and builds/deploys on Cloudflare's side. The deploy credential (a build token) lives **inside Cloudflare** and never exists in GitHub, the repo, or any dev sandbox. GitHub Actions keeps only test/lint — **Actions Secrets become empty**.

**Why not OIDC?** As of 2026-08, the Cloudflare API has **no OIDC / workload identity federation** (wrangler-action supports only `apiToken`; the OIDC feature request remains an open GitHub Discussion — workers-sdk#11434). Workers Builds is the only mechanism where GitHub holds zero Cloudflare credentials. Verified against live docs 2026-08-08.

## When to use this skill

- New or existing Workers project deployed from a GitHub repo, especially with an autonomous agent in the loop (no long-lived secret should be reachable from CI or a sandbox)
- Migrating off a `deploy.yml` + `CLOUDFLARE_API_TOKEN` setup
- NOT for: Pages projects (different product), pipelines that must deploy from non-GitHub/GitLab CI (fall back to a minimal-permission custom token — see `cloudflare-api-token-permissions`)

## Architecture and the one invariant

Workers Builds triggers on **push** and does **NOT wait for GitHub CI results**. So the gate moves to merge time:

> **Invariant: code on `main` is always CI-green** — enforced by a branch ruleset (PR required + required status check + no bypass actors). Workers Builds then only ever builds green code.

```
PR branch push → GitHub Actions ci (typecheck/test)   [GitHub side, no secrets]
merge to main (ruleset: PR + check "ci" required)      [human or auto-merge]
   └→ Workers Builds: install → build → D1 migrate → wrangler deploy   [Cloudflare side]
```

See [references/ruleset.md](references/ruleset.md) for the exact `gh api` ruleset payload (pins the required check to the GitHub Actions app via `integration_id: 15368`, `bypass_actors: []` so even the repo owner cannot push main) and [references/ci-yml.md](references/ci-yml.md) for the secrets-free CI workflow.

## One-time human ceremony (secret-zero)

Each step once, by a human (these create/handle credentials):

1. **Custom build token** (BEFORE connecting, so the first build can run D1 migrations): dash → My Profile → API Tokens → Create Custom Token with **Account/Workers Scripts/Edit + Account/D1/Edit + Account/Account Settings/Read + User/User Details/Read + User/Memberships/Read**. No client-IP filtering (builds run from Cloudflare infra), no expiry (it never leaves Cloudflare). The token string never needs to be copied anywhere — it is *selected from a list* in the build settings.
2. **Connect repo**: dash → Workers & Pages → Create → "Continue with GitHub" / Import a repository. In the GitHub authorization, choose **Only select repositories** → the one repo.
3. **Project setup** (see table below). ⚠️ **Root directory is hidden inside the "Advanced settings" accordion** at the bottom of the setup dialog — easy to miss, and without it every command runs at the repo root and fails.
4. After creation: Settings → Build → set the **API token** to the custom token (if the setup dialog offered no token picker) and **disable non-production branch builds** under Branch control.

## Settings that matter

| Setting | Value | Trap if wrong |
|---|---|---|
| Worker/project name | exactly `name` from wrangler.jsonc | name mismatch → deploy creates a second Worker |
| Root directory (Advanced settings!) | the package dir containing wrangler.jsonc, e.g. `apps/web` | commands run at repo root; build + deploy both fail |
| Build command | `pnpm install --frozen-lockfile && pnpm run build` | explicit install guards monorepo lockfile auto-detection (lockfile lives at repo root, root directory doesn't); pnpm finds the workspace root upward automatically |
| Deploy command | `pnpm exec wrangler d1 migrations apply <DB_NAME> --remote && pnpm exec wrangler deploy` | migrations must precede deploy; `pnpm exec` uses the repo-pinned wrangler |
| API token | custom token incl. **D1 Edit** | the auto-generated default build token has **no D1 permission** — `d1 migrations apply` then fails the build with `Authentication error [code: 10000]`, which names auth but **not the real cause** (the build token lacking D1 Edit). Only old wrangler (<3.83.0) failed with no output at all (workers-sdk #5077, closed 2026-04) |
| Branch control | production branch = `main`; **non-production branch builds OFF** | ⚠️ preview versions share the **production D1 binding** (`preview_database_id` applies only to `wrangler dev`, not uploaded versions) — PR previews would hit prod data, and a preview running migrations would migrate prod |
| Build watch paths (Advanced) | default `*` = build everything; to skip docs-only deploys, **exclude** `docs/*` and `*.md` (keep include `*`) | excludes are evaluated first and match only docs/markdown, so a code change is **never** skipped and a mixed commit still builds; safe because the required `ci` check is **independent** of Workers Builds (still runs, still gates merge). Do NOT skip CI via `paths-ignore` — the required check goes pending and the PR sticks. Always builds on 0-change / 3000+ files / 20+ commits. Dashboard-only (not in wrangler.jsonc). |

Plan limits (2026-06): Free = 3,000 build min/month, 1 concurrent build, 20 min timeout — plenty for a solo project.

## Verification

```bash
# Cloudflare reports build status as a GitHub check run on the commit:
gh api repos/<owner>/<repo>/commits/<sha>/check-runs \
  --jq '.check_runs[] | {name, status, conclusion}'
# → {"name":"Workers Builds: <worker>","conclusion":"success"} + your "ci" check

wrangler deployments list                # new deployment after merge
wrangler d1 migrations list <DB> --remote  # "No migrations to apply!" = applied
curl https://<worker>.<subdomain>.workers.dev/health
```

Note: workers.dev URLs are always `<worker-name>.<account-subdomain>.workers.dev` — a bare `<name>.workers.dev` does not exist. If the account subdomain matters (OAuth redirect URIs, WebAuthn RP_ID), decide/rename it **before** registering those, since renaming changes every Worker URL in the account.

Build status lives in the **`Workers Builds: <worker>` check-run** above — that plus `wrangler deployments list` is how you read pass/fail/queued from the CLI. The Workers **Builds REST API** (`/accounts/<id>/builds/*`) is **not** reachable with a `wrangler login` OAuth token (returns `10000` *Authentication error* — a real route the token lacks scope for, vs `7003` for a bogus path), and `wrangler` has no `builds` subcommand. For queued/running/failed detail beyond the check-run, use the dashboard **Builds** tab — the **Version history** tab lists only *successful* deploys, never failures/skips.

## Failure modes seen in the wild

- **Build fails immediately, weird path errors** → Root directory not set (it's in Advanced settings).
- **Build green until migration step, opaque exit** → default build token without D1 Edit. Swap token in Settings → Build, Retry.
- **Nothing builds on push** → (a) push to a non-production branch with branch builds off (intended); (b) watch-paths excluded everything (see *Settings*); or (c) a **transient missed trigger** — even with a healthy connection, a production-branch merge, and watch-paths=`*`, Cloudflare occasionally creates **no build at all** for a commit. Diagnose with the commit's check-runs: a built commit carries a **`Workers Builds: <worker>`** check-run (app `cloudflare-workers-and-pages`); if only `ci` is present the build was **never triggered** — distinct from a *failed* check-run (built then failed). `gh api repos/<owner>/<repo>/commits/<sha>/check-runs --jq '.check_runs[].name'`. **Re-trigger by pushing a new commit to `main`** — retrying the latest build in the dashboard rebuilds *that* commit, not the missed one. (Don't read `commits/<sha>/status` `total_count:0` as "no signal" — Workers Builds & Actions both report via the Checks API, not legacy statuses.)
- **Deploy succeeded but old code serves** → check `wrangler deployments list`; the dashboard build log tells you which commit was built.
