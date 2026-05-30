---
name: claude-code-docker-sandbox
description: Set up a Docker Compose-isolated development environment where npm installs and agent-run code execute behind a default-deny network firewall, never touching the host. Use when starting a Node/JS project and you want to run `npm install`, untrusted dependencies, or Claude Code itself inside a container to contain npm supply-chain attacks — without depending on VS Code. Reuses Anthropic's published devcontainer Dockerfile + init-firewall.sh but drives them with a plain docker-compose.yml so any host editor (nvim, etc.) works via bind mount. Covers the egress allowlist, the in-container Claude Code OAuth "paste code" flow, the telemetry-domain DNS trap that kills the firewall, and host-side git operation hygiene.
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets Linux/macOS hosts with Docker + Docker Compose v2. Container is node:20 base, non-root `node` user, iptables/ipset egress firewall (needs NET_ADMIN + NET_RAW). Host editor + git stay outside the container; only npm/build/agent execution is isolated.
metadata:
  author: okayus
  version: "0.1.0"
---

# Claude Code Docker Sandbox

Get a Node/JS project to the state where **`npm install`, build tools, and Claude Code all run inside a container behind a default-deny iptables firewall**, while you edit files from your normal host editor and run `git` on the host.

**Why do this**: npm supply-chain attacks execute arbitrary code at `install` time (`postinstall` scripts) and at run time. A naked `npm install` on the host can read `~/.ssh`, `~/.aws/credentials`, exfiltrate over the network, or backdoor your shell rc files. This skill confines all of that to a container whose only network egress is an explicit allowlist (npm registry, GitHub, your model API, your deploy target) — everything else is rejected at the OS level.

This is the **non-VS-Code** path. Anthropic's official `.devcontainer/` reference assumes a VS Code / Dev Containers spec editor. Here the same hardened `Dockerfile` + `init-firewall.sh` are driven by a plain `docker-compose.yml`, so the workflow is `docker compose exec dev zsh` + any host editor.

## When to use this skill

- Starting a new Node/JS/TS project and you do not want `npm install` to run on the host
- You use nvim / helix / emacs / any non-VS-Code editor and the official dev container flow doesn't fit
- You want to run Claude Code (or another coding agent) with reduced permission friction, knowing an OS-level boundary contains it
- You're spooked by a recent npm compromise and want a repeatable isolation baseline across projects

Do **not** use this when: you need the full VS Code Dev Containers UX (use the official `.devcontainer/` instead), you're on native Windows without WSL2 (the firewall needs Linux netfilter — run inside WSL2 or a Linux VM), or you require kernel-level separation against truly untrusted code (use a VM/microVM instead — a container shares the host kernel).

## Threat model & limits (read before relying on it)

- **What it stops**: `postinstall` scripts and run-time code from writing outside the project dir, reading host home/credentials, or reaching non-allowlisted network hosts. Blast radius of a malicious package is the bind-mounted project dir + the allowlisted domains.
- **What it does NOT stop**: data exfiltration *through* an allowlisted domain (e.g. pushing secrets to a GitHub repo you allowed — the firewall filters by hostname, not by intent), kernel exploits (shared kernel), or anything you mount writable. Keep the allowlist narrow and never mount host secrets (`~/.ssh`, cloud cred files) into the container.
- **git push stays on the host.** Don't put git credentials in the container. The agent inside can read `git status`/`git log` (the `.git` dir is bind-mounted) but you run `commit`/`push` from the host. This keeps your GitHub token out of the isolation boundary.

## Deliverables (completion criteria)

You're done when:

1. `docker compose up -d` starts the container and the logs end with `Firewall verification passed - unable to reach https://example.com as expected` followed by `... able to reach https://api.github.com as expected`.
2. `docker compose exec dev sh -c 'curl --connect-timeout 5 -s -o /dev/null -w "%{http_code}" https://example.com'` prints `000` (blocked), and the same against `https://registry.npmjs.org` prints `200`.
3. `docker compose exec dev zsh` drops you into `/workspace` as the non-root `node` user, and your project files are visible there (bind mount works).
4. Inside the container, `claude` authenticates successfully and `/status` shows the model — and survives `docker compose down && docker compose up -d` (auth persisted in the `claude-config` volume).
5. Host-side edits to project files appear inside the container without a rebuild.

## Setup order

Copy the three template files into your repo, then build and verify. Full commented copies are in `references/`.

1. **`.docker/Dockerfile`** — copy [references/Dockerfile](references/Dockerfile) verbatim. It is Anthropic's published devcontainer image: `node:20`, non-root `node` user, dev tools, `git-delta`, zsh+powerlevel10k, `@anthropic-ai/claude-code` installed globally, and a passwordless-sudo rule scoped to *only* `init-firewall.sh`.

2. **`.docker/init-firewall.sh`** — copy [references/init-firewall.sh](references/init-firewall.sh). Edit the `for domain in ...` allowlist (see [Tuning the allowlist](#tuning-the-egress-allowlist)) to match what your project actually needs. GitHub IP ranges are fetched dynamically; you only list extra domains.

3. **`docker-compose.yml`** — copy [references/docker-compose.yml](references/docker-compose.yml) into the repo root. Replace the `<project>` placeholder in `container_name`. Adjust the published port (`5173` = Vite default) to your dev server.

4. **Build & start**:
   ```sh
   docker compose build       # 5–10 min first time (apt, zsh-in-docker, claude install)
   docker compose up -d
   docker compose logs dev    # confirm the two "Firewall verification passed" lines
   ```
   If `docker compose build` fails with `dial tcp: lookup production.cloudfront.docker.com ... server misbehaving`, that's a transient Docker Hub DNS hiccup — just re-run `docker compose build`.

5. **Authenticate Claude Code inside the container** — follow [references/authentication.md](references/authentication.md). The key trap: the OAuth localhost callback can't reach the container, so you copy the URL to a host browser and paste the returned code back at the `Paste code here if prompted` prompt.

6. **Verify** against the deliverables above.

## Tuning the egress allowlist

`init-firewall.sh` sets default-deny and only permits: DNS, SSH, localhost, the host /24, dynamically-fetched GitHub ranges, plus the domains you list in the `for domain in ...` loop. The template ships with:

```sh
for domain in \
    "registry.npmjs.org" \
    "api.anthropic.com" \
    "api.cloudflare.com" \
    "dash.cloudflare.com" \
    "workers.cloudflare.com"; do
```

- **`registry.npmjs.org`** — required for `npm install`.
- **`api.anthropic.com`** — required for Claude Code to reach the model. (Using Bedrock/Vertex/Foundry instead? Swap in that provider's endpoint.)
- **Cloudflare entries** — only if you deploy to Cloudflare. Drop them otherwise.
- Add the registry of any other package manager (`registry.yarnpkg.com`), private registries, or CDN hosts your toolchain fetches from at runtime.

> **The telemetry-domain DNS trap.** The script does `exit 1` if *any* listed domain fails to resolve, and that failure kills the container (the firewall is the entrypoint). Anthropic's reference list includes `statsig.anthropic.com`, `sentry.io`, and VS Code Marketplace domains. If one of those intermittently fails DNS, the whole container won't start. **Remove domains you don't need** — for a non-VS-Code, telemetry-off setup, drop the VS Code and Statsig/Sentry entries entirely, and set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (already in the compose template) so Claude Code doesn't try to reach them anyway.

After editing the allowlist you must rebuild, because the script is `COPY`d into the image:
```sh
docker compose down && docker compose build && docker compose up -d
```

## Daily workflow

Each in its own host terminal:

```sh
# A: dev server (runs inside container, bridged to host)
docker compose up -d
docker compose exec dev zsh
#   then, in-container:  npm run dev -- --host 0.0.0.0   →  http://localhost:<port>

# B: the agent
docker compose exec dev zsh
#   then, in-container:  claude

# C: edit on the host
nvim .

# D: git on the host (NOT in the container)
git add -p && git commit && git push
```

Lifecycle: `exit`/Ctrl-D leaves the shell (container keeps running). `docker compose stop` pauses, `docker compose down` removes the container+network but **keeps named volumes** (auth survives). `docker compose down -v` wipes volumes too — you'll have to re-authenticate Claude.

## Gotchas

- **`--dangerously-skip-permissions` is rejected as root.** The image runs as non-root `node` specifically so you *can* use it (and the firewall is the real boundary). The compose file sets `user: node` — don't override it to root.
- **Bubblewrap-based `/sandbox` inside the container** needs `enableWeakerNestedSandbox: true` because an unprivileged container can't mount a fresh `/proc`. You usually don't need it — the container *is* the sandbox. Don't nest unless you have a specific reason.
- **`docker` / Windows binaries don't work in the firewall'd container** — by design; this is a leaf dev environment, not a Docker-in-Docker host.
- **First MCP server start is slow** if `.mcp.json` uses `npx -y <pkg>` (fetches on first run). Cached afterward in the container home.
- **New external service added mid-project** → its domain won't resolve/connect until you add it to the allowlist and rebuild. The symptom is a hang or `Connection refused` to a brand-new host.
- **Scaffolding a project non-interactively** inside the container (e.g. `npx sv create`, `create-vite`, `create-next-app`) has its own prompt-stall traps — see [references/scaffold-notes.md](references/scaffold-notes.md).

## What this skill deliberately does NOT do

- It does not install or configure VS Code, Dev Containers extension, or `@devcontainers/cli` (adding the latter means a host `npm install`, defeating the point).
- It does not put git credentials in the container.
- It does not TLS-inspect egress (the firewall filters by hostname only). For exfil-resistant setups, front it with a MITM proxy that terminates TLS.
