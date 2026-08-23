---
name: cloudflare-workers-builds-keyless-deploy
description: Deploy Cloudflare Workers from GitHub with ZERO Cloudflare credentials stored in GitHub (no CLOUDFLARE_API_TOKEN in Actions secrets), using Workers Builds — Cloudflare's git-connected CI/CD. Use when setting up or migrating a Workers project so that an autonomous agent pipeline never holds a Cloudflare secret, when asked "can we deploy without a CF API token in CI", or when driving the Cloudflare dashboard connect ceremony (by hand or with a browser agent). Covers the traps that cost hours — the custom token you made in My Profile NOT appearing in the build-token picker (use "Create new token" inside Advanced settings; it includes D1 Edit as of 2026-08 despite the docs), the picker defaulting to ANOTHER project's build token, Root directory hiding in the Advanced settings accordion (labelled "Path"), the first build after connecting being a manual build that posts NO "Workers Builds" check-run (not a missed trigger), preview builds sharing the PRODUCTION D1 database, Workers Builds NOT waiting for GitHub CI (gate with a branch ruleset instead), and skipping docs-only deploys with build watch paths.
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets Cloudflare Workers (wrangler.jsonc) + D1 + pnpm monorepos, GitHub repos. Requires gh CLI for ruleset setup; dashboard access for the one-time ceremony (a browser-automation agent can drive it — see references/dashboard-walkthrough.md).
metadata:
  author: okayus
  version: "0.3.0"
---

# Cloudflare Workers Builds: Keyless Deploy

Replace "GitHub Actions runs `wrangler deploy` with a `CLOUDFLARE_API_TOKEN` secret" with **Workers Builds**: Cloudflare pulls the repo via its GitHub App and builds/deploys on Cloudflare's side. The deploy credential (a build token) lives **inside Cloudflare** and never exists in GitHub, the repo, or any dev sandbox. GitHub Actions keeps only test/lint — **Actions Secrets become empty**.

**Why not OIDC?** As of 2026-08, the Cloudflare API has **no OIDC / workload identity federation** (wrangler-action supports only `apiToken`; the OIDC feature request remains an open GitHub Discussion — workers-sdk#11434). Workers Builds is the only mechanism where GitHub holds zero Cloudflare credentials. Verified against live docs 2026-08-08; the dashboard ceremony below was re-run and corrected on kokemusu 2026-08-23 (see *Verified on kokemusu*).

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

Once per project, by a human or a browser agent under human supervision (it creates a credential). Screen-by-screen labels (Japanese UI, English equivalents), direct URLs and browser-agent tips are in [references/dashboard-walkthrough.md](references/dashboard-walkthrough.md) — read it before driving the dashboard.

**Pre-flight, from the terminal, before opening the dashboard** (each of these stopped the kokemusu run):

```bash
git fetch origin && git ls-tree --name-only origin/main apps/web/wrangler.jsonc   # must print the path: the production branch must ALREADY contain the root directory
gh pr list --state open                                                          # the skeleton PR must be merged, not open
grep -n '"name"\|database_id' apps/web/wrangler.jsonc; wrangler d1 list           # name = the Worker name you will type; database_id = a real UUID that exists
wrangler whoami                                                                   # the account the dashboard is logged into (the browser may run on another machine — only the account matters)
wrangler deployments list                                                         # expect "This Worker does not exist" [code: 10007] — a pre-existing Worker of that name would be taken over
```

**Steps** (dashboard as of 2026-08-23):

1. **GitHub App scope**. Workers & Pages → Create → *Continue with GitHub*. If the *Cloudflare Workers and Pages* GitHub App is **already installed** on the GitHub account (from an earlier project), **no authorization screen appears** — the repository list shows straight away with whatever scope that installation has. To keep **Only select repositories**, manage it on GitHub (Settings → Applications → *Cloudflare Workers and Pages* → Repository access) **before** connecting; narrowing an existing *All repositories* installation touches every project built from that account, so list them first.
2. **Setup dialog**. Project name = exactly `name` from wrangler.jsonc; build + deploy commands from the table below; **untick "Builds for non-production branches"** (it is in the dialog, ticked by default — no need to wait for Settings). Then **open the "Advanced settings" accordion** at the bottom: it hides three things — **Root directory** (labelled *Path*, default `/`), the **API token** picker, and build variables. In the picker choose **Create new token** and name it `<worker> Workers Builds`. **Do not leave the default**: the picker pre-selects the build token of whatever project you connected last (kokemusu's default was `nyalog Workers Builds`), which silently couples the two projects' deploy credentials.
3. **Deploy**. Click *Deploy*: the Worker is created (two placeholder `Upload` deployments appear at once) and the **first build starts as a manual build** of the production branch HEAD — roughly 2 minutes (init ≈ 50 s, clone, install, build, migrate + deploy). A *Workers Paid* upsell modal appears — dismiss it. The build page's *Build settings* panel shows exactly what was saved (commands, root directory, token name) — confirm it there.
4. **Settings → Builds afterwards**: confirm token and branch control, add **build watch paths** excludes (`docs/*`, `*.md`: type, Enter, then *Save* on the toast). Nothing else.

**Dropped step — do not pre-create a custom token in My Profile.** The 0.2.0 recipe said to create a Workers Scripts + D1 + Account Settings + User Details + Memberships custom token first and "select it from the list". On 2026-08-23 that token **did not appear in the picker** at all (searched by name → "No labels found"); the picker listed only the dash-generated `<project> Workers Builds` tokens of other projects plus *Create new token* — even though the docs say you may "select one that you already own". If you already made one, delete it in My Profile → API Tokens: it is an unused token with Edit rights.

## Settings that matter

| Setting | Value | Trap if wrong |
|---|---|---|
| Worker/project name | exactly `name` from wrangler.jsonc | name mismatch → deploy creates a second Worker |
| Root directory (Advanced settings!, labelled *Path* in the setup dialog) | the package dir containing wrangler.jsonc, e.g. `apps/web` | commands run at repo root; build + deploy both fail. Also fails if the production branch doesn't contain that directory yet (unmerged skeleton PR) — a branch problem that looks like a settings problem |
| Build command | `pnpm install --frozen-lockfile && pnpm run build` | explicit install guards monorepo lockfile auto-detection (lockfile lives at repo root, root directory doesn't); pnpm finds the workspace root upward automatically (log shows `Scope: all N workspace projects`) |
| Deploy command | `pnpm exec wrangler d1 migrations apply <DB_NAME> --remote && pnpm exec wrangler deploy` | migrations must precede deploy; `pnpm exec` uses the repo-pinned wrangler |
| API token (Advanced settings!) | **Create new token** in the picker, named `<worker> Workers Builds` | The docs (checked 2026-08-23) still describe the generated token as *Account Settings read, Workers Scripts / KV / R2 edit, Workers Routes edit, User Details / Memberships read* — **no D1**. The dashboard notice on the same day listed a wider set **including D1 Storage (edit)** (plus Vectorize, Queues, Pipelines, Containers, Cloudchamber, Connectivity Directory, AI Search), and `d1 migrations apply --remote` succeeded on the first build. If a build fails at the migrate step with `Authentication error [code: 10000]`, open My Profile → API Tokens and add **D1 Edit** to that token in place (`cloudflare-api-token-permissions`) — the error names auth but not the missing permission. Never accept the picker's pre-selected default (another project's token). Old wrangler (<3.83.0) failed with no output at all (workers-sdk #5077, closed 2026-04) |
| Branch control | production branch = `main`; **non-production branch builds OFF** (tick-box is in the setup dialog and in Settings → Builds) | ⚠️ preview versions share the **production D1 binding** (`preview_database_id` applies only to `wrangler dev`, not uploaded versions) — PR previews would hit prod data, and a preview running migrations would migrate prod |
| Build watch paths (Settings → Builds) | default `*` = build everything; to skip docs-only deploys, **exclude** `docs/*` and `*.md` (keep include `*`) | excludes are evaluated first and match only docs/markdown, so a code change is **never** skipped and a mixed commit still builds; safe because the required `ci` check is **independent** of Workers Builds (still runs, still gates merge). Do NOT skip CI via `paths-ignore` — the required check goes pending and the PR sticks. Always builds on 0-change / 3000+ files / 20+ commits. Dashboard-only (not in wrangler.jsonc); the exclude box's grey `node_modules/**, .git/` is placeholder text, not a value |

Plan limits (2026-06): Free = 3,000 build min/month, 1 concurrent build, 20 min timeout — plenty for a solo project.

## Verification

```bash
# Cloudflare reports build status as a GitHub check run on the commit:
gh api repos/<owner>/<repo>/commits/<sha>/check-runs \
  --jq '.check_runs[] | {name, status, conclusion}'
# → {"name":"Workers Builds: <worker>","conclusion":"success"} + your "ci" check
# If `gh api` is denied by the project's .claude/settings.json, a PUBLIC repo answers unauthenticated:
curl -s -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/<owner>/<repo>/commits/<sha>/check-runs

wrangler deployments list                # new deployment after merge
wrangler d1 migrations list <DB> --remote  # "No migrations to apply!" = applied
curl https://<worker>.<subdomain>.workers.dev/health
```

**Right after the ceremony the production HEAD carries only the `ci` check-run.** The first build was a *manual* build and posts no `Workers Builds: <worker>` check — this is expected and is **not** the missed-trigger case below. The push → build path is proven only by the next commit to `main` (under the ruleset: a PR). Until then the evidence is the dashboard *Builds* tab plus `wrangler deployments list`, where the Workers Builds deploy shows `Source: Unknown (deployment)` and the two `Upload` entries created at the same minute are the Worker-creation placeholders.

Note: workers.dev URLs are always `<worker-name>.<account-subdomain>.workers.dev` — a bare `<name>.workers.dev` does not exist. If the account subdomain matters (OAuth redirect URIs, WebAuthn RP_ID), decide/rename it **before** registering those, since renaming changes every Worker URL in the account.

Build status lives in the **`Workers Builds: <worker>` check-run** above — that plus `wrangler deployments list` is how you read pass/fail/queued from the CLI. The Workers **Builds REST API** (`/accounts/<id>/builds/*`, documented at `/workers/ci-cd/builds/api-reference/`) needs a **user** token carrying `Workers Builds Configuration: Edit` — so a `wrangler login` OAuth token gets `10000` *Authentication error* (a real route the token lacks scope for, vs `7003` for a bogus path), and `wrangler` has no `builds` subcommand. For queued/running/failed detail beyond the check-run, use the dashboard **Builds** tab — the **Version history** tab lists only *successful* deploys, never failures/skips.

## Failure modes seen in the wild

- **"My custom token is not in the API token picker"** → expected as of 2026-08-23 (see *Dropped step*). Use *Create new token*; do not loop back to My Profile.
- **Build fails immediately, weird path errors** → Root directory not set (it's *Path* inside Advanced settings) — or the production branch does not contain that directory yet (skeleton PR unmerged). Check `git ls-tree origin/main <root>/wrangler.jsonc` before touching settings.
- **Build green until migration step, `Authentication error [code: 10000]`** → the selected build token lacks D1 Edit (another project's older token, or a generated token from before D1 was included). Add D1 Edit to the token in place, or switch to *Create new token* in Settings → Builds, then Retry **once**.
- **First build green but no `Workers Builds:` check-run on GitHub** → the first build is manual; prove the trigger with a real push to `main` instead of re-running it.
- **Nothing builds on push** → (a) push to a non-production branch with branch builds off (intended); (b) watch-paths excluded everything (see *Settings*); or (c) a **transient missed trigger** — even with a healthy connection, a production-branch merge, and watch-paths=`*`, Cloudflare occasionally creates **no build at all** for a commit. Diagnose with the commit's check-runs: a built commit carries a **`Workers Builds: <worker>`** check-run (app `cloudflare-workers-and-pages`); if only `ci` is present the build was **never triggered** — distinct from a *failed* check-run (built then failed). `gh api repos/<owner>/<repo>/commits/<sha>/check-runs --jq '.check_runs[].name'`. **Re-trigger by pushing a new commit to `main`** — retrying the latest build in the dashboard rebuilds *that* commit, not the missed one. (Don't read `commits/<sha>/status` `total_count:0` as "no signal" — Workers Builds & Actions both report via the Checks API, not legacy statuses.)
- **Deploy succeeded but old code serves** → check `wrangler deployments list`; the dashboard build log tells you which commit was built.

## Verified on kokemusu (2026-08-23) — and what is still open

Second application of this skill (after mazuoboeru / nyalog), driven by a browser agent (Claude in Chrome on a Mac, CLI on Linux). Worker `kokemusu`, account subdomain `shiraoka`, pnpm monorepo with root directory `apps/web`.

- Build `#de3ceaea`: init 53 s / clone 4 s / install 18 s / build 11 s / deploy 36 s. Log: `Detected the following tools from environment: pnpm@9.15.0, nodejs@24.18.0`, `Scope: all 2 workspace projects`. Migrate + deploy succeeded **first try** on the dash-generated token; `/health` → 200, `d1 migrations list --remote` → `No migrations to apply!`.
- The 0.2.0 "custom token first" step cost a full token-creation round and produced an orphan token (`workers-builds-kokemusu`, 5 permissions, never selectable) — hence *Dropped step* above.
- The picker's default was another project's token (`nyalog Workers Builds`) with a yellow "missing permissions: email_routing_…" notice — that notice is noise unless the Worker uses Email Routing.
- Pre-flight mattered: `main` did not yet contain `apps/web` (three PRs open) — connecting at that point would have failed the first build at the path step for a non-settings reason.
- UNVERIFIED: why a hand-made user token is absent from the picker (filtered by creator? by full permission set? — the docs say existing tokens are selectable). Re-check on the next project before restoring the old step.
- UNVERIFIED: a push-triggered build on kokemusu (only the manual first build has run as of writing) — expect `Workers Builds: kokemusu` on the next merge to `main`.
- UNVERIFIED: the English labels of the setup dialog (run under the Japanese dashboard); *Path* / *Advanced settings* are translations, *Root directory* is confirmed by the docs' settings table.
