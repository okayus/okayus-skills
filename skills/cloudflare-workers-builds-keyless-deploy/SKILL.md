---
name: cloudflare-workers-builds-keyless-deploy
description: Deploy Cloudflare Workers from GitHub with ZERO Cloudflare credentials stored in GitHub (no CLOUDFLARE_API_TOKEN in Actions secrets), using Workers Builds — Cloudflare's git-connected CI/CD. Use when setting up or migrating a Workers project so that an autonomous agent pipeline never holds a Cloudflare secret, or when asked "can we deploy without a CF API token in CI". Covers the traps that cost hours — the default build token lacking D1 Edit (with silent migration failure), Root directory hiding in the Advanced settings accordion, preview builds sharing the PRODUCTION D1 database, and Workers Builds NOT waiting for GitHub CI (gate with a branch ruleset instead).
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets Cloudflare Workers (wrangler.jsonc) + D1 + pnpm monorepos, GitHub repos. Requires gh CLI for ruleset setup; dashboard access for the one-time ceremony.
metadata:
  author: okayus
  version: "0.1.0"
---

# Cloudflare Workers Builds: Keyless Deploy

Replace "GitHub Actions runs `wrangler deploy` with a `CLOUDFLARE_API_TOKEN` secret" with **Workers Builds**: Cloudflare pulls the repo via its GitHub App and builds/deploys on Cloudflare's side. The deploy credential (a build token) lives **inside Cloudflare** and never exists in GitHub, the repo, or any dev sandbox. GitHub Actions keeps only test/lint — **Actions Secrets become empty**.

**Why not OIDC?** As of 2026-06, the Cloudflare API has **no OIDC / workload identity federation** (wrangler-action supports only `apiToken`; the OIDC feature request sits unanswered as a GitHub Discussion). Workers Builds is the only mechanism where GitHub holds zero Cloudflare credentials. Verified against live docs 2026-06-10.

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
| API token | custom token incl. **D1 Edit** | the auto-generated default build token has **no D1 permission**, and wrangler d1 migrations are known to **fail silently / opaquely** on permission errors (workers-sdk #5077) — a red build with no clear error usually means this |
| Branch control | production branch = `main`; **non-production branch builds OFF** | ⚠️ preview versions share the **production D1 binding** (`preview_database_id` applies only to `wrangler dev`, not uploaded versions) — PR previews would hit prod data, and a preview running migrations would migrate prod |

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

## Failure modes seen in the wild

- **Build fails immediately, weird path errors** → Root directory not set (it's in Advanced settings).
- **Build green until migration step, opaque exit** → default build token without D1 Edit. Swap token in Settings → Build, Retry.
- **Nothing builds on push** → repo connected but the push was to a non-production branch with branch builds off (intended), or watch-paths excluded everything.
- **Deploy succeeded but old code serves** → check `wrangler deployments list`; the dashboard build log tells you which commit was built.
