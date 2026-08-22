---
name: cloudflare-mcp-claude-tooling
description: Wire up the Claude Code project tooling for a Cloudflare Workers project developed inside the docker sandbox — a docs-only Cloudflare MCP, a committed `.claude/settings.json` permission allowlist that denies `git commit`/`push` as an execution-level guard for the "git on the host" rule, the egress-firewall domains the docs MCP needs, and the `grill-with-docs` design step. Use when starting a new Cloudflare project (after the sandbox is up) and you want Claude Code's MCP + permissions + design scaffolding set up deliberately. Covers WHY you take docs-only and route account operations through wrangler instead of the bindings/builds/observability MCP servers (OAuth callback is fragile in a container; they overlap with wrangler anyway), plus the documentation-access recipe for the firewalled agent (server-side WebSearch, per-host OPTIONAL egress for WebFetch, which sites publish `llms.txt`, the Context7 MCP with MDN, Modern Web Guidance at project scope).
license: MIT
compatibility: Designed for Claude Code. Assumes a project already running in the claude-code-docker-sandbox (egress firewall + bind mount). Pairs with cloudflare-workers-deploy-skeleton for the deploy pipeline. wrangler + an OAuth-authenticated Claude Code in the container.
metadata:
  author: okayus
  version: "0.2.0"
---

# Cloudflare MCP + Claude Code project tooling

Get a new Cloudflare Workers project (already running in the [`claude-code-docker-sandbox`](../claude-code-docker-sandbox/SKILL.md)) to a state where the in-container Claude Code has: the Cloudflare **docs** MCP connected, a **committed permission allowlist** that lets it run pnpm/wrangler/git-read freely while blocking `git commit`/`push`, and the **`grill-with-docs`** design skill available — so you can stress-test the plan before writing the walking skeleton.

This is the layer **between** "the sandbox is up" and "build the walking skeleton" (`cloudflare-workers-deploy-skeleton`).

## When to use this skill

- You just stood up the sandbox for a new Cloudflare Workers project and want the Claude Code tooling configured before coding.
- You're tempted to add the Cloudflare `bindings`/`builds`/`observability` MCP servers and want the decision framework first.
- You want the "git stays on the host" rule enforced by configuration, not just documented.

## The core decision: docs-only MCP, account ops via wrangler

Cloudflare ships several hosted MCP servers (`https://*.mcp.cloudflare.com/mcp`). They are **not** equal:

| Server | Auth | Verdict |
|---|---|---|
| `cloudflare-docs` (`docs.mcp.cloudflare.com`) | **none** | **Take it.** Searches Cloudflare docs — something `wrangler` cannot do. Connects with no OAuth. |
| unified `Cloudflare API` (`mcp.cloudflare.com/mcp`) | OAuth **or API token** | Skip by default — same `wrangler` overlap. If you ever do need account ops via MCP, this is the current first choice (token auth, Code Mode). |
| `cloudflare-bindings` (`bindings.mcp.cloudflare.com`) | OAuth | Skip. Overlaps `wrangler d1/kv/r2`. |
| `cloudflare-builds` (`builds.mcp.cloudflare.com`) | OAuth | Skip. |
| `cloudflare-observability` (`observability.mcp.cloudflare.com`) | OAuth | Skip. Overlaps `wrangler tail`. |

**Why docs-only:**
- The account-touching servers **duplicate `wrangler`**, which the in-container agent already runs (allowlisted below). You lose little by leaving them out.
- **OAuth from inside the container is no longer a blocker** — since Claude Code 2.1.191, MCP OAuth in headless environments prints the authorization URL and accepts the redirect URL pasted back (same paste-style flow as Claude Code login; `--no-browser` forces it). No localhost callback, no port publishing. It's still an extra per-rebuild approval dance, but the decisive reason to skip these servers is the `wrangler` overlap above, not OAuth friction. (Verified against the Claude Code changelog + MCP docs, 2026-08-07.)
- `docs` needs no auth and is the highest-value server for *writing* Workers/wrangler config correctly.

> If you later genuinely need an account MCP server, the unified `mcp.cloudflare.com/mcp` is the current first candidate — it officially supports **API-token (Bearer header)** auth alongside OAuth. Mint a least-privilege token per the [`cloudflare-api-token-permissions`](../cloudflare-api-token-permissions/SKILL.md) matrix and pass it via `headers` with `${ENV}` expansion in `.mcp.json`. Token auth stays callback-free; OAuth is also workable in-container since Claude Code 2.1.191 (paste-the-redirect-URL flow). Lineup verified 2026-08-07.

## Files to create (templates in references/)

1. **`.mcp.json`** (project root, **committed**) — docs-only. Copy [references/mcp.json](references/mcp.json).
   ```json
   { "mcpServers": { "cloudflare-docs": { "type": "http", "url": "https://docs.mcp.cloudflare.com/mcp" } } }
   ```
   Project-scoped MCP servers prompt for a one-time workspace-trust approval the first time Claude Code loads the dir.

2. **`.claude/settings.json`** (project root, **committed**) — copy [references/settings.json](references/settings.json). It allowlists the day-to-day commands so the agent isn't prompted constantly, and **denies `git commit` / `git push`**:
   ```jsonc
   "allow": [ "Bash(pnpm install:*)", ..., "Bash(wrangler d1:*)", "Bash(wrangler tail:*)",
              "Bash(git status:*)", "Bash(git diff:*)", "Bash(gh pr view:*)",
              "WebFetch(domain:developers.cloudflare.com)", "WebFetch(domain:docs.mcp.cloudflare.com)" ],
   "deny":  [ "Bash(git push:*)", "Bash(git commit:*)" ]
   ```
   The `deny` is the point: it turns "git happens on the host, not in the sandbox" from a CLAUDE.md *convention* into an **execution-level guard** — the in-container agent literally cannot commit/push (keeping GitHub credentials out of the boundary). Allow only the *read* git/gh verbs. The template also sets `"enableAllProjectMcpServers": false` — servers from the committed `.mcp.json` get approved individually rather than wholesale.

   **If the sandbox is later allowed to commit or push, narrow the deny accordingly** — a broad `Bash(git push:*)` deny beats every allow rule. With `sandboxed-agent-git-relay`: allow `git add/commit/checkout/switch`, keep only `git push` denied (its step 7). With `sandboxed-agent-github-token-via-1password`: allow `git push origin claude/*` + `gh pr create/view/checks` and deny force pushes / `main` / `gh pr merge` / `gh auth` instead (its `compose-and-git-wiring.md`).

3. **`.gitignore`** additions — keep per-user/secret config out of git:
   ```
   docker-compose.override.yml        # host-specific skills mount (see sandbox skill)
   .claude/settings.local.json        # per-user overrides; .claude/settings.json IS committed
   ```

4. **Egress firewall domains** — add to the sandbox's `.docker/init-firewall.sh` `for domain in ...` list (then rebuild, see below):
   ```sh
   "developers.cloudflare.com" \   # WebFetch of CF docs
   "docs.mcp.cloudflare.com"       # the docs MCP server
   ```
   These can share Cloudflare anycast IPs with other CF hosts — the sandbox template's `ipset -exist` handles that. **Rebuild from the project dir with NO `-f`** so `docker-compose.override.yml` (skills mount) is not dropped:
   ```sh
   docker compose down && docker compose build && docker compose up -d
   ```

## The design step: grill-with-docs

Before the walking skeleton, stress-test the plan. Install [`grill-with-docs`](https://github.com/mattpocock/skills/tree/main/skills/engineering/grill-with-docs) at **project scope** so it travels with the repo and is visible to the in-container agent (it lives under the `/workspace` bind mount):

```sh
mkdir -p <project>/.claude/skills/grill-with-docs
# copy the upstream skill directory WHOLESALE — its internal layout has changed
# before (2026-08 it holds SKILL.md + agents/); don't cherry-pick named files
```

Then run `/grill-with-docs` and let it interview you one question at a time, capturing vocabulary in `CONTEXT.md` and hard-to-reverse decisions in `docs/adr/NNNN-*.md`. Good first targets: auth method, public/private model, scoring/grading rules — the choices that are expensive to change after code exists.

## Giving the sandboxed agent documentation access

The firewall is default-deny, so "look it up in the docs" needs a plan. Three layers, verified on kokemusu 2026-08-22:

| Layer | Mechanism | Egress needed |
|---|---|---|
| **WebSearch** | runs on Anthropic's backend (`api.anthropic.com`, already fatal-allowlisted); returns titles + URLs only | none |
| **WebFetch** | fetched by the Claude Code process *in the container* | the docs host — add it to the firewall's **OPTIONAL** list (a resolve failure must not kill the container) and, for host sessions, a `WebFetch(domain:…)` allow rule |
| **MCP** | `cloudflare-docs` (no auth) + **Context7** (`https://mcp.context7.com/mcp`, key optional; indexes MDN — `mdn/content`, ~9 M tokens — plus Hono, Drizzle, React, Vite, Cloudflare Workers) | `docs.mcp.cloudflare.com`, `mcp.context7.com` |

Which sites speak `llms.txt` (probed 2026-08-22): **yes** — `hono.dev` (+ `llms-full.txt`), `orm.drizzle.team` (+ full), `react.dev`, `vite.dev`, `vitest.dev`, `zod.dev`, `swr.vercel.app`, `developers.cloudflare.com`, `developer.chrome.com/docs/css-ui/`; **no** — MDN, typescriptlang.org, tailwindcss.com, web.dev, playwright.dev (use Context7 or fetch the page). Tell the agent the order in `CLAUDE.md`: Context7 / cloudflare-docs → `llms.txt` index then the page (`llms-full.txt` last, it is huge) → WebSearch, then WebFetch only inside the allowlist.

`.mcp.json` with both servers (project MCP servers still need the one-time interactive trust approval; `claude mcp list` shows `⏸ Pending approval` until then — after it, `✔ Connected`, and an in-container `claude -p` resolved `/mdn/content` via Context7 and answered a `<dialog closedby>` question correctly):

```json
{ "mcpServers": {
    "cloudflare-docs": { "type": "http", "url": "https://docs.mcp.cloudflare.com/mcp" },
    "context7":        { "type": "http", "url": "https://mcp.context7.com/mcp" } } }
```

OPTIONAL-list entries that worked: `mcp.context7.com developer.mozilla.org react.dev hono.dev orm.drizzle.team vite.dev vitest.dev zod.dev developer.chrome.com web.dev`. Two caveats: the allowlist is **IP-based**, so the shared anycast IPs admit sibling sites (hono/drizzle/zod = Cloudflare, react.dev = Vercel, MDN = Fastly, chrome = Google) — acceptable for read-only docs, and why `context7.com` (the website) stays blocked while `mcp.context7.com` is open; and `mcp.context7.com` is an AWS ELB whose IPs can rotate — the firewall resolves at container start, so if Context7 stops answering, restart the container.

**Modern Web Guidance** (Google Chrome, Apache-2.0 — "use the platform, don't reinvent `<dialog>` / popover / anchor positioning / container queries in React"): install at project scope so it rides the bind mount and is reviewable — `npx skills add GoogleChrome/modern-web-guidance@modern-web-guidance -a claude-code -y` → `.claude/skills/modern-web-guidance/` (SKILL.md + ~140 guides, 1.3 MB) + `skills-lock.json`; update with `npx skills update`. Its `search` / `retrieve` run `npx -y modern-web-guidance@latest …` — the npm registry is already fatal-allowlisted, so it works in the sandbox (first call downloads the package; no call to Google at runtime). The Claude Code plugin route (`/plugin marketplace add GoogleChrome/modern-web-guidance`) lands in `~/.claude/plugins` instead — not visible through the skills mount.

## Verify

```sh
# docs MCP connected, account servers absent:
# (run AFTER approving workspace trust in an interactive session — since Claude Code
#  2.1.196, unapproved project servers show "⏸ Pending approval" here instead)
docker compose exec -T dev claude mcp list | grep cloudflare        # → cloudflare-docs: ... ✓ Connected
# egress reaches docs, non-allowlisted host still blocked:
docker compose exec -T dev sh -c 'curl -so/dev/null -w "%{http_code}\n" https://docs.mcp.cloudflare.com/'   # 404 = reachable
docker compose exec -T dev sh -c 'curl -so/dev/null -w "%{http_code}\n" https://example.com/'               # 000 = blocked
```

## Gotchas

- **Rebuild from the project dir, no `-f`** — otherwise `docker-compose.override.yml` (host skills mount) silently unloads. See the sandbox skill's Gotchas.
- **IP-based firewall can't block one anycast host while allowing another** on the same IP (docs vs bindings often share IPs). Removing an account server from the allowlist may still leave it TCP-reachable; what actually keeps it unused is **omitting it from `.mcp.json`**, not the firewall.
- **`.claude/settings.json` is committed; `.claude/settings.local.json` is per-user** — never commit the latter (gitignored above). Review a project's `settings.json` before trusting the repo, since it can widen tool access.
- **Project MCP servers need a one-time trust approval** in each fresh checkout (`claude mcp reset-project-choices` to reset).

## Related skills

- [`claude-code-docker-sandbox`](../claude-code-docker-sandbox/SKILL.md) — the egress-firewalled container this runs inside; owns the `init-firewall.sh` allowlist, the skills-mount override, and the `-f` gotcha.
- [`cloudflare-workers-deploy-skeleton`](../cloudflare-workers-deploy-skeleton/SKILL.md) — the next step: the SPA+API+Cron walking skeleton.
- [`cloudflare-api-token-permissions`](../cloudflare-api-token-permissions/SKILL.md) — least-privilege tokens, if you opt into Bearer-auth MCP or CI deploys.
