---
name: claude-code-docker-sandbox
description: Set up a Docker Compose-isolated development environment where dependency installs and agent-run code execute behind a default-deny network firewall, never touching the host. Use when starting a Node/TS, Rust, or Haskell project and you want to run `npm install` / `cargo build` / `cabal build`, untrusted dependencies, or Claude Code itself inside a container to contain supply-chain attacks (npm postinstall, Rust build.rs, Haskell Setup.hs) — without depending on VS Code. Reuses Anthropic's published devcontainer Dockerfile + init-firewall.sh but drives them with a plain docker-compose.yml so any host editor (nvim, etc.) works via bind mount; Rust/Haskell toolchains are opt-in build args layered on the node:20 base (Claude Code needs Node regardless). Covers the egress allowlist, the build-time-vs-runtime network distinction, the in-container Claude Code OAuth "paste code" flow, the telemetry-domain DNS trap that kills the firewall, and host-side git operation hygiene.
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets Linux/macOS hosts with Docker + Docker Compose v2. Container is node:20 base, non-root `node` user, iptables/ipset egress firewall (needs NET_ADMIN + NET_RAW). Host editor + git stay outside the container; only npm/build/agent execution is isolated.
metadata:
  author: okayus
  version: "0.2.0"
---

# Claude Code Docker Sandbox

Get a Node/JS project to the state where **`npm install`, build tools, and Claude Code all run inside a container behind a default-deny iptables firewall**, while you edit files from your normal host editor and run `git` on the host.

**Why do this**: supply-chain attacks execute arbitrary code at dependency-install/build time and at run time — npm `postinstall` scripts, Rust `build.rs`, Haskell custom `Setup.hs` are all the same class of hole. A naked `npm install` / `cargo build` / `cabal build` on the host can read `~/.ssh`, `~/.aws/credentials`, exfiltrate over the network, or backdoor your shell rc files. This skill confines all of that to a container whose only network egress is an explicit allowlist (the package registry, GitHub, your model API, your deploy target) — everything else is rejected at the OS level.

**Languages**: the base image is `node:20` because Claude Code itself is an npm package and needs a Node runtime even in a Rust- or Haskell-only project. Rust (rustup) and Haskell (GHCup) are **opt-in `--build-arg` layers** on top — see [Language toolchains](#language-toolchains-rust--haskell).

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

3. **`docker-compose.yml`** — copy [references/docker-compose.yml](references/docker-compose.yml) into the repo root. Replace the `<project>` placeholder in `container_name`. Adjust the published port (`5173` = Vite default) to your dev server. For a Rust/Haskell project, set `INSTALL_RUST`/`INSTALL_HASKELL` to `"true"` here and uncomment the matching registry block in step 2 — see [Language toolchains](#language-toolchains-rust--haskell).

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

> **Two robustness fixes are baked into the template** (learned from real failures; keep them):
> - **`dig` retry.** The embedded Docker DNS can intermittently time out at start — *worse when several sandboxes come up at once*. A single failed `dig` would `exit 1` and kill the container, so the resolve loop retries up to 5×. This is the safety net the telemetry-trap note above warns you need.
> - **`ipset add -exist`.** Providers like Cloudflare serve many hostnames from a *shared anycast IP*. The same IP can already be in the set from an earlier domain; without `-exist` the duplicate add returns non-zero and `set -e` kills the container mid-config. Corollary: because filtering is **IP-based**, you cannot allow one anycast hostname while blocking another that resolves to the same IP (e.g. `docs.mcp.cloudflare.com` vs `bindings.mcp.cloudflare.com`). Control which servers are *used* at the app layer (e.g. `.mcp.json`), not the firewall.

After editing the allowlist you must rebuild, because the script is `COPY`d into the image:
```sh
docker compose down && docker compose build && docker compose up -d
```
⚠️ Run rebuild/`up` **from the project directory with NO `-f` flag** — see the override-loading trap in [Gotchas](#gotchas).

## Language toolchains (Rust / Haskell)

The image is Node-first (Claude Code needs it). Rust and Haskell are added only when you flip a build arg, so a TS project stays the small original image.

**Enable in `docker-compose.yml`** under `build.args` (and rebuild):
```yaml
INSTALL_RUST: "true"      # rustup + cargo, pinned RUST_VERSION
INSTALL_HASKELL: "false"  # GHCup + GHC + cabal — heavy, see warning
```

### The one rule that explains the whole design: build-time vs runtime network

The firewall is the container **entrypoint** — it runs at `docker compose up`, *after* the image is already built. Toolchain installation happens earlier, during `docker compose build`, where **there is no firewall**. Two consequences:

| | Installed/fetched | Needs firewall allowlist entry? |
|---|---|---|
| Compiler/runtime (rustc, GHC, cabal) | build time (`Dockerfile RUN`) | **No** — CDN reached before firewall exists |
| Dependencies (`cargo build`, `cabal build`) | runtime, in-container | **Yes** — registry must be allowlisted |

So in `init-firewall.sh` you add only the **package registries**, not the toolchain CDNs:
- **Rust** → `index.crates.io`, `static.crates.io` (add `static.rust-lang.org` only if you run `rustup update`/add toolchains at runtime)
- **Haskell** → `hackage.haskell.org` (add `downloads.haskell.org` only if you `ghcup install` at runtime)

The commented blocks are already in `init-firewall.sh`; uncomment your language and rebuild (the script is `COPY`d into the image). And the attack you care about — `build.rs` / `Setup.hs` running arbitrary code — fires at **runtime**, where the firewall *is* active. That's the whole point.

### Warnings
- **Haskell is heavy**: GHC adds several GB and ~10–20 min to the first build. Enable `INSTALL_HASKELL` only on Haskell projects.
- **One language per project**: you *can* set both true, but the image balloons. Prefer one toolchain per repo.
- **Pin versions**: `RUST_VERSION` / `GHC_VERSION` / `CABAL_VERSION` are build args. Pinning keeps the one-time build-time fetch (itself a supply-chain surface) reproducible.
- **Verify in-container**: after `up`, `cargo --version` / `ghc --version && cabal --version` should work alongside `claude`.

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
- **`-f` silently disables `docker-compose.override.yml`.** Compose auto-loads `docker-compose.override.yml` only when you run from the project directory *without* `-f`. The moment you pass `docker compose -f /path/to/docker-compose.yml up`, the override is **not** merged — any mounts/ports/env it added (e.g. the [host-skills mount](#mounting-host-skills-into-the-container)) silently vanish, and the container comes back missing them with no error. **Always `cd` into the project dir and run plain `docker compose ...`.** Diagnose with `docker compose config` (shows the merged result) vs `docker inspect <container> --format '{{json .Mounts}}'` (shows what the *running* container actually has) — if they disagree, an `-f` invocation recreated it without the override.

## Mounting host skills into the container

The bind mount only exposes the project (`/workspace`). Claude Code skills that live *outside* the project — e.g. a personal skills repo you maintain as a sibling directory — are invisible to the in-container agent, so its `~/.claude/skills` is empty.

Expose them **read-only via a gitignored `docker-compose.override.yml`** (single source of truth, no copy → no drift):

```yaml
# docker-compose.override.yml  (gitignore this — it encodes a host-specific path)
services:
  dev:
    volumes:
      - ../my-skills/skills:/home/node/.claude/skills:ro
```

The named `claude-config` volume still owns the rest of `~/.claude` (auth persists); only the `skills` subpath is the bind. Each `skills/<name>/SKILL.md` becomes a user-scope skill in the container. Re-`up` from the project dir (no `-f`, per the gotcha above) and verify with `docker compose exec -T dev ls /home/node/.claude/skills`. Project-scope skills go the normal way — commit them to `<project>/.claude/skills/`, which is already inside the `/workspace` bind mount.

## What this skill deliberately does NOT do

- It does not install or configure VS Code, Dev Containers extension, or `@devcontainers/cli` (adding the latter means a host `npm install`, defeating the point).
- It does not put git credentials in the container.
- It does not TLS-inspect egress (the firewall filters by hostname only). For exfil-resistant setups, front it with a MITM proxy that terminates TLS.
