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
| [`cloudflare-workers-deploy-skeleton`](skills/cloudflare-workers-deploy-skeleton/) | Walking-Skeleton setup for a single-Worker SPA + API + Cron on Cloudflare Workers with D1 and GitHub Actions auto-deploy. Covers the 3-layer SPA routing dance, wrangler.jsonc template, deploy.yml, and the well-known setup pitfalls (D1 token scope, `pnpm deploy` collision, RP_ID locking). |
| [`cloudflare-cron-to-discord`](skills/cloudflare-cron-to-discord/) | Cron Trigger → Discord Webhook pattern with the pure-function-then-boundary architecture. Covers UTC→JST pure conversion, build/post separation with throw-free error handling, vitest mock testing, dev/prod webhook naming for contamination detection, and the `/__scheduled` dev caveat with `@cloudflare/vite-plugin`. |

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
