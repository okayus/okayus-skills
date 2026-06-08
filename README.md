# okayus-skills

Agent Skills for Claude Code / GitHub Copilot / other [Agent Skills](https://agentskills.io)-compatible agents.

Extracted from production-ready patterns used across my personal projects (Cloudflare Workers + D1 + Discord integrations).

## Installing

Pick a skill and install it with the GitHub CLI skill extension:

```bash
# Project scope (recommended for project-specific patterns)
gh skill install okayus/okayus-skills <skill-name> --agent claude-code --scope project

# User scope (available in every project)
gh skill install okayus/okayus-skills <skill-name> --agent claude-code --scope user
```

Pin to a version (optional):

```bash
gh skill install okayus/okayus-skills <skill-name>@v1.0.0 --agent claude-code
```

## Available skills

| Skill | What it does |
|---|---|
| [`claude-code-docker-sandbox`](skills/claude-code-docker-sandbox/) | Set up a Docker Compose-isolated dev environment where `npm install` and agent-run code execute behind a default-deny iptables egress firewall, never touching the host — to contain npm supply-chain attacks **without** depending on VS Code. Reuses Anthropic's published devcontainer `Dockerfile` + `init-firewall.sh` but drives them with a plain `docker-compose.yml` so any host editor (nvim, etc.) works via bind mount. Covers egress allowlist tuning, the in-container Claude Code OAuth "paste code" flow, the telemetry-domain DNS trap that silently kills the container, host-side git hygiene (keep credentials out of the boundary), the non-interactive scaffolding traps (`sv`/`create-*` prompt stalls), mounting a host skills repo read-only via a gitignored `docker-compose.override.yml`, the `-f`-flag trap that silently unloads that override, and the `dig` retry + `ipset -exist` robustness for flaky DNS and shared anycast IPs. Ships copy-paste templates for all four files. |
| [`cloudflare-workers-deploy-skeleton`](skills/cloudflare-workers-deploy-skeleton/) | Walking-Skeleton setup for a single-Worker SPA + API + Cron on Cloudflare Workers with D1 and GitHub Actions auto-deploy. Covers the 3-layer SPA routing dance, wrangler.jsonc template, deploy.yml, and the well-known setup pitfalls (D1 token scope, `pnpm deploy` collision, RP_ID locking). |
| [`cloudflare-mcp-claude-tooling`](skills/cloudflare-mcp-claude-tooling/) | Wire the Claude Code project tooling for a sandboxed Cloudflare project: a docs-only Cloudflare MCP (`docs.mcp.cloudflare.com`), a committed `.claude/settings.json` allowlist that denies `git commit`/`push` as an execution-level guard for the "git on the host" rule, the egress-firewall domains the docs MCP needs, and the `grill-with-docs` design step. Covers WHY docs-only — the bindings/builds/observability MCP servers overlap with `wrangler` and their OAuth callback is fragile in a container (vs Claude Code login's paste-code flow) — and the API-token (Bearer) escape hatch if you ever need an account server. |
| [`cloudflare-cron-to-discord`](skills/cloudflare-cron-to-discord/) | Cron Trigger → Discord Webhook pattern with the pure-function-then-boundary architecture. Covers UTC→JST pure conversion, build/post separation with throw-free error handling, vitest mock testing, dev/prod webhook naming for contamination detection, and the `/__scheduled` dev caveat with `@cloudflare/vite-plugin`. |
| [`cloudflare-d1-drizzle-migration`](skills/cloudflare-d1-drizzle-migration/) | Safely run drizzle-kit migrations on Cloudflare D1 without losing data. Covers the silent `PRAGMA foreign_keys=OFF` incompatibility (D1 ignores it, so table-rebuild migrations cascade-delete child rows), the phased NULLABLE → backfill → NOT NULL column migration pattern for live databases, the mandatory pre-deploy backup + post-deploy row count check runbook, and 3 meta-lessons on environment parity, test blind spots, and destructive-change design review. |
| [`cloudflare-workers-e2e-playwright`](skills/cloudflare-workers-e2e-playwright/) | Wire Playwright e2e tests against a Cloudflare Workers + Vite + Hono app without falling into the two silent traps: strict CSP blocking Vite's HMR inline preamble (preventing React mount on `page.reload()`) and `wrangler dev --config` resolving D1 state to a different empty sqlite. Covers why to target the build artifact via `wrangler dev` instead of `vite dev`, why `--persist-to .wrangler/state` is mandatory, the WebAuthn virtual authenticator recipe (avoiding `DEV_BYPASS_USER_ID` so register/login wiring is actually tested), and the narrow "3 specs only" test scope philosophy. |
| [`cloudflare-d1-weekly-backup-via-pr`](skills/cloudflare-d1-weekly-backup-via-pr/) | Set up an automated weekly Cloudflare D1 backup workflow via GitHub Actions that exports the production database and opens a PR adding the SQL dump to the repo. Covers the "GitHub Actions is not permitted to create or approve pull requests" repo-setting gotcha (every fresh repo's first PR-creating workflow trips it), the cron schedule UTC-vs-local timezone conversion, the `wrangler d1 export` path-relativity quirk in pnpm monorepos, the explicit "commit backups to git" decision with its trade-offs and migration triggers, and reusing the existing `CLOUDFLARE_API_TOKEN` (no new secrets). |
| [`cloudflare-api-token-permissions`](skills/cloudflare-api-token-permissions/) | Map a Cloudflare CI deploy auth error (`code: 10000` / `7403` / `9106`) to the missing API token permission, and the permission matrix per binding (Workers Scripts / D1 / R2 / KV / Queues / Vectorize / Hyperdrive / Workers AI / Browser Rendering). Covers the in-place permission edit workflow that keeps the token value (so the GitHub Secret stays untouched), the `Edit Cloudflare Workers` template's silent omission of D1 / R2 / Queues, the diagnostic flow when multiple permissions are missing cumulatively, and how to identify which token CI is actually using. |
| [`cloudflare-workers-bot-scan-defense`](skills/cloudflare-workers-bot-scan-defense/) | Make a Cloudflare Workers app resilient to bot scans that arrive within minutes of HTTPS publication via CT Log enumeration (`/.env`, `/.git/config`, `/admin`, `/wp-login.php` probing). Covers the mental model (which paths actually cost you money — most are absorbed by the edge cache via SPA fallback), the audit recipe (`curl -I` checking for `cf-cache-status: HIT`), the narrow set of unauthenticated routes that need rate limiting (auth `begin`/`verify`), the exact `wrangler.jsonc` `observability` + `ratelimits` config, the IP-keyed Hono middleware pattern using `CF-Connecting-IP`, the verification flow (`wrangler versions view` + bundle grep + Workers Observability), and the documented eventual-consistency caveat that makes synthetic burst tests look like the limiter is broken even when correctly wired. Includes the binding-vs-WAF-rule decision matrix. |
| [`cloudflare-workflows-for-long-tasks`](skills/cloudflare-workflows-for-long-tasks/) | Migrate a Cloudflare Worker post-response task off `ctx.waitUntil()` onto a `WorkflowEntrypoint` when the task can exceed the 30-second `waitUntil` wall-clock cap (Vision LLM, slow third-party APIs, multi-step orchestration). Covers the symptom-to-fix path when `waitUntil() tasks did not complete within the allowed time` shows up in `wrangler tail` and DB rows get stuck in `running` / `pending`, the exact `wrangler.jsonc` workflows binding, the class export pattern alongside `default app`, the `step.do()` retry / persist / serializable-output rules, the production cleanup runbook for orphaned rows, and the gotchas (`Workflow<Params>` is a `@cloudflare/workers-types` global not a `cloudflare:workers` import; bytes can't ride between steps; Workflow logs surface in the Dashboard, not `wrangler tail`). |

## Repo layout

```
okayus-skills/
├── README.md
├── LICENSE
└── skills/
    └── <skill-name>/
        ├── SKILL.md        # metadata + core instructions
        └── references/     # on-demand deep docs, code templates, diagnostics
```

Follows the [Agent Skills specification](https://agentskills.io/specification) `skills/*/SKILL.md` convention.

## Versioning

Each release is tagged with semver (`v0.1.0`, `v1.0.0`, ...). Installing without `@VERSION` resolves to the latest release.

Skill-specific breaking changes bump the repo's major version. Additive refinements (new references, clarifications) bump the minor or patch version.

## Validating locally

Skills are validated with `gh skill publish --dry-run`:

```bash
cd ~/dev/okayus-skills
gh skill publish --dry-run
```

Checks: name matches directory, required frontmatter, etc. See [spec](https://agentskills.io/specification).

## License

[MIT](LICENSE).
