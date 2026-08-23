# Where the token enters, git / gh wiring, Claude Code rules

Two injection points are documented. **Use the first.** The second is what 0.1.x shipped; it is kept because it is what you will find in existing projects, and because its failure modes are worth recognising.

| | **Default: exec-time** | Alternative: compose `environment:` |
|---|---|---|
| Token is part of the container config | no | **yes** |
| `docker compose up -d` without `op run` | harmless, idempotent (`Running`) | **recreates the container** — token gone, every process inside killed |
| Who has the token | the `./shell.sh` shell and its children | every process in the container, incl. PID 1 |
| Rotation | open a new `./shell.sh` | `./up.sh` → container recreated |
| `docker inspect … Config.Env` | no `GH_TOKEN` line at all | `GH_TOKEN=…` (or the bare-key / empty failure shapes) |
| Cost | you must remember to use `./shell.sh` | you must remember never to plain-`up` |

## Default: exec-time injection — `up.sh` + `shell.sh`

Both are committed; neither contains a secret. `up.sh` starts the container and has nothing to do with the token:

```sh
#!/usr/bin/env sh
# Start (or recreate) the dev sandbox. No credential is involved: the GitHub token is
# injected per shell by ./shell.sh, so this is plain, idempotent `docker compose up`.
#
#   ./up.sh            # = docker compose up -d
#   ./up.sh --build    # extra args go to `docker compose up`
#
# Run from this directory without -f so docker-compose.override.yml is auto-loaded.
set -eu
cd "$(dirname "$0")"
exec docker compose up -d "$@"
```

`shell.sh` is the only door the token comes through:

```sh
#!/usr/bin/env sh
# Open a shell in the running dev sandbox WITH the repo-scoped GitHub token, resolved
# from 1Password and injected into THIS shell only (never into the container config).
#
#   ./shell.sh                      # zsh that can `git push` / `gh pr create`
#   ./shell.sh claude --continue    # or run a command directly
#
# Why not `environment: { GH_TOKEN: ... }` in docker-compose.yml? Then the token is
# part of the container's config, and any `docker compose up -d` that doesn't go
# through `op run` counts as a config change: compose stops and RECREATES the
# container, silently dropping the token and every process inside (including a
# running Claude session). Injecting at exec time keeps `./up.sh` credential-free and
# idempotent. `docker exec -e GH_TOKEN` (name only, no `=value`) forwards the variable
# from this process's environment — the value never appears in argv, so it is not
# visible in `ps` on the host. Fail closed: no op, no token, no push.
#
# Skill: sandboxed-agent-github-token-via-1password (exec-time variant).
set -eu
cd "$(dirname "$0")"
[ "$#" -gt 0 ] || set -- zsh

state=$(docker inspect -f '{{.State.Running}}' <container> 2>/dev/null || echo missing)
[ "$state" = "true" ] || {
  echo "shell.sh: container <container> is not running (state: $state). Start it with ./up.sh" >&2
  exit 1
}

exec op run --env-file=.docker/sandbox.env -- sh -c '
  [ -n "${GH_TOKEN:-}" ] || {
    echo "shell.sh: op did not resolve GH_TOKEN — check .docker/sandbox.env and the op session" >&2
    exit 1
  }
  exec docker exec -it -e GH_TOKEN <container> "$@"
' shell.sh "$@"
```

`chmod +x up.sh shell.sh`. Four details:

- **`-e GH_TOKEN`, name-only.** "The Docker CLI client checks the value the variable has in your local environment and passes it to the container"; with no `=` and nothing exported, the variable stays unset inside (`docker run` reference — the `docker exec` page doesn't state it, verified by experiment 2026-08-23). So the value is taken from `op run`'s environment and **never enters argv**: `ps -eo args` on the host shows `docker exec -e GH_TOKEN <container> zsh`. Writing `-e GH_TOKEN="$GH_TOKEN"` would put the secret in every process listing on the box.
- **The inner `sh -c` guard** turns "op resolved nothing" into a message instead of a silent tokenless shell. `op run` exits 0 with the variable unset in some failure modes, so checking is not redundant.
- **`exec op run … -- sh -c '…' shell.sh "$@"`** — the trailing `shell.sh "$@"` sets `$0` and re-supplies the arguments to the inner shell, so `./shell.sh claude --continue` works and quoting survives.
- **`-it`** is right for an interactive shell; drop `-t` for non-interactive one-liners driven from a script (`./shell.sh zsh -lc '…'` is fine either way in practice).

Substitute your container name for `<container>` (the compose `container_name:`).

## `docker-compose.yml` startup command — credential helper + identity

Add to the `command:` chain of the committed compose file (before `exec sleep infinity`). The helper is inert without a token, so it is safe in the distributed file and it is what makes exec-time injection work: it reads `$GH_TOKEN` **at push time**, from whatever shell git was invoked in.

```yaml
    command: >
      sh -c "sudo /usr/local/bin/init-firewall.sh &&
             (npm i -g @anthropic-ai/claude-code@latest pnpm@9.15.0 ||
              echo 'WARN: claude/pnpm update failed; using image-baked versions') &&
             (git config --global credential.helper '!f() { echo username=x-access-token; echo \"password=$$GH_TOKEN\"; }; f' &&
              git config --global user.name 'Claude (<project> sandbox)' &&
              git config --global user.email 'claude-sandbox@users.noreply.github.com' ||
              echo 'WARN: git credential/identity setup failed') &&
             echo 'NOTE: no GitHub token in the container env by design - open a shell with ./shell.sh to push / gh pr create' &&
             ([ -s /home/node/.claude/settings.json ] || echo '{}' > /home/node/.claude/settings.json) &&
             (jq '.permissions.defaultMode = \"bypassPermissions\"' /home/node/.claude/settings.json > /tmp/cs.json &&
              mv /tmp/cs.json /home/node/.claude/settings.json ||
              echo 'WARN: could not set bypassPermissions default') &&
             exec sleep infinity"
```

Three details:

- **`$$GH_TOKEN`**, not `$GH_TOKEN`: compose interpolates `$VAR` in the YAML at parse time; `$$` yields a literal `$` so the *container's* shell expands it when git calls the helper. `docker compose config` echoing `$$GH_TOKEN` back is the output re-escaping `$`, not a bug.
- The helper is the relay's (`relay.mjs`: `credential.helper=!f() { echo username=x-access-token; echo "password=$GIT_RELAY_TOKEN"; }; f`) with the env var renamed. `x-access-token` is accepted as the username for token auth over HTTPS; the token is the password. Nothing is written under `~/.git-credentials`, and `~/.gitconfig` lives in the container layer (re-created each start), not in a named volume.
- The identity makes sandbox commits distinguishable in `git log` / PR history from your host commits — same convention as the relay's step 7.

Put a comment next to the `environment:` block saying the token is deliberately **not** there, or the next session will helpfully add it back.

If you change the helper's shape and the quoting fights you, bake a script instead and point the helper at it:

```sh
# .docker/git-credential-env  (COPY into /usr/local/bin/ in the Dockerfile, chmod 755)
#!/bin/sh
# git credential helper: answer `get` from the environment, never touch disk.
[ "${1:-}" = "get" ] || exit 0
echo "username=x-access-token"
echo "password=${GH_TOKEN:-}"
```

```sh
git config --global credential.helper /usr/local/bin/git-credential-env
```

## Alternative: the token in the compose `environment:` (what 0.1.x shipped)

Pick this only if every process in the container needs the token — e.g. a long-running unattended job that nobody will open a shell for — and you accept that `docker compose up` becomes a destructive command.

`docker-compose.override.yml` (gitignored, host-specific):

```yaml
services:
  dev:
    environment:
      # Resolved from the environment of the `docker compose` process, i.e. from
      # `op run` in ./up.sh. See the failure table below before trusting either form.
      GH_TOKEN: "${GH_TOKEN:-}"      # explicit interpolation; unset -> "" (set but empty)
      # GH_TOKEN:                    # valueless pass-through; unset -> a BARE key, no `=`
```

and `up.sh` goes back to `exec op run --env-file=.docker/sandbox.env -- docker compose up -d "$@"`.

Neither form behaves the way 0.1.x described. The three observed shapes — bare key with no `=` / real value / resolved-to-empty — are tabulated once, in `SKILL.md` § *Correction to 0.1.x*; read it before trusting either form.

Compose warns in none of the three cases, so the startup command must say what it got. Use the **3-valued** check — a two-valued "absent" cannot tell "compose resolved an empty string" (the value never reached `op run`'s subprocess) from "the key never arrived" (you skipped the wrapper), and that distinction is an hour of debugging:

```yaml
             ([ -n \"$$GH_TOKEN\" ] && echo \"NOTE: GH_TOKEN present (len=$${#GH_TOKEN})\" ||
              echo \"NOTE: GH_TOKEN $${GH_TOKEN+is empty}$${GH_TOKEN-is unset} - this container can commit but NOT push. Start it via ./up.sh\") &&
```

`docker compose logs <service> | grep GH_TOKEN` → `present (len=93)` / `is empty` / `is unset`. Never echo the value.

**The hazard you are accepting**: the token is now part of the container's configuration, so "if there are existing containers for a service, and the service's configuration or image was changed after the container's creation, `docker compose up` picks up the changes by stopping and recreating the containers" (compose `up` reference). One plain `docker compose up -d` without `op run` is such a change — the container is recreated, the token is gone and every process inside is killed. Consequences to write into `CLAUDE.md`: **`docker compose up` is the destructive command** — never run it from inside the container, and think before running it on the host (`docker compose exec` is safe: it is "the equivalent of `docker exec` targeting a Compose service"). And rotation has no gentle path here — the container's env is fixed at creation, so `./up.sh` with a new value recreates it (verified 2026-08-23 — no `--force-recreate` needed) and kills what was running.

## `gh` needs nothing

`gh` honours `GH_TOKEN` directly: "an authentication token that will be used when a command targets either github.com or a subdomain of ghe.com. Setting this avoids being prompted to authenticate and takes precedence over previously stored credentials" (gh manual, 2026-08-22). Do **not** run `gh auth login` in the container — it writes the token to `~/.config/gh/hosts.yml` on disk (the container's writable layer: it survives `stop` / `start` / `restart` and is only discarded by `down`), which is exactly the on-disk copy this design avoids. `gh auth status` shows the env token as active.

## `.claude/settings.json` (committed) — replace the blanket push deny

Starting from the `cloudflare-mcp-claude-tooling` template:

```jsonc
{
  "permissions": {
    "allow": [
      // … pnpm / wrangler / read-only git as before …
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(git switch:*)",
      "Bash(git checkout:*)",
      "Bash(git fetch:*)",
      "Bash(git push origin claude/*)",
      "Bash(git push -u origin claude/*)",
      "Bash(gh pr create:*)",
      "Bash(gh pr view:*)",
      "Bash(gh pr list:*)",
      "Bash(gh pr diff:*)",
      "Bash(gh pr checks:*)",
      "Bash(gh pr comment:*)",   // the usable stand-in for `gh pr edit`, which errors on Projects classic
      "Bash(gh run list:*)",
      "Bash(gh run view:*)"
    ],
    "deny": [
      // NOT "Bash(git push:*)" — a broad deny beats every allow above.
      "Bash(git push * --force*)",
      "Bash(git push --force*)",
      "Bash(git push -f *)",
      "Bash(git push *main)",          // ends in main: `origin main`, `HEAD:main`, `HEAD:refs/heads/main`
      "Bash(git push *main *)",        // same with trailing flags
      "Bash(git push * --delete *)",
      "Bash(gh pr merge *)",          // drop this line (and add the --auto form to allow) for opt-in agent merges
      "Bash(gh auth *)",              // no `gh auth login` (stores a token), no `gh auth token` (prints it)
      "Bash(gh api *)"                // the merge endpoint is one PUT away; read CI via `gh pr checks`
    ]
  },
  "enableAllProjectMcpServers": false
}
```

Rules to keep in mind (Claude Code permissions docs, 2026-08-22): a deny rule matches regardless of a narrower allow; `*` spans spaces, so `Bash(git push origin claude/*)` also matches `git push origin claude/x:main` — **the ruleset rejects that push, the rule doesn't**; patterns constraining arguments are documented as fragile; deny rules still apply in `bypassPermissions` mode while **allow rules have no effect there** (permission-modes docs) — so inside the container (bypass by default) only the `deny` list acts, and the `allow` list is for host / non-bypass sessions on the same repo. Pushing the head of an open, rule-satisfying PR to `main` is *allowed* by GitHub — it is the merge (verified 2026-08-22) — which is why the refspec forms are denied here too. Treat this list as keeping the well-behaved agent on the rails, nothing more.

Opt-in agent merge: replace the `gh pr merge` deny with `"Bash(gh pr merge --auto --squash *)"` in `allow` and enable *Allow auto-merge* on the repo (see `rulesets-and-policy.md`).

## `CLAUDE.md` paragraph for the project

> **git in the sandbox**: the token lives only in shells opened with `./shell.sh` — if `git push` returns `401` or `gh` says it is not logged in, you are in a plain `docker exec` shell and the human has to open a tokened one; do not try to work around it. Commit on `claude/<topic>`, `git push -u origin claude/<topic>`, open the PR with `gh pr create --fill` and report the URL; watch CI with `gh pr checks`. To revise a PR body use `gh pr comment` — `gh pr edit` fails on a Projects-classic GraphQL error. Never merge (the human merges from the host) / or: signal a merge only with `gh pr merge --auto --squash` when you are confident. `GH_TOKEN` is the project's repo-scoped token — don't print it, don't `gh auth login`, don't put it in a URL. `.github/workflows/**` changes are pushed by the human (the token has no `workflows` permission). Never run `docker compose up` from inside; `./up.sh` is the human's command.

## Verification

On the host — the container must hold no token, and `up` must be inert:

```sh
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' <container> | grep -c '^GH_TOKEN'   # → 0
docker inspect -f '{{.Id}}' <container>                                    # note the id
./up.sh                                                                   # → "Running", not "Recreated"
docker inspect -f '{{.Id}}' <container>                                    # same id
ps -eo args | grep '[d]ocker exec'                                         # `-e GH_TOKEN` with NO value after it
```

If you kept the env variant, the first line becomes `grep -c '^GH_TOKEN=.'` — with the `=` *and* a character after it. `cut -d= -f1 | grep -c` counts a bare, unresolved key as present; plain `'^GH_TOKEN='` also counts the resolved-to-empty case. Both will tell you the token is there when it is not. The 3-valued startup check below is the authority; this is the spot check.

Inside `./shell.sh`:

```sh
echo "${#GH_TOKEN}"                             # a length (93 for a fine-grained PAT), never the value
gh auth status 2>&1 | grep -c GH_TOKEN          # → 1 (the full output prints the token's id prefix — keep it out of transcripts)
git config --global credential.helper           # the inline helper, a single $GH_TOKEN
ls ~/.git-credentials ~/.config/gh/hosts.yml 2>&1   # → No such file (nothing on disk)
git ls-remote --heads origin | head -3          # read works
git switch -c claude/e2e-token && git commit --allow-empty -m "chore: e2e token push" && git push -u origin claude/e2e-token
gh pr create --fill && gh pr checks --watch
# negative: a commit with NO open PR — the head of an open CI-green PR would MERGE instead of being rejected
git switch -c claude/e2e-nopr && git commit --allow-empty -m "e2e: no PR" && git push origin HEAD:main   # → GH013 … Changes must be made through a pull request
```

Fail-closed, from a shell that skipped the wrapper:

```sh
docker exec -it <container> zsh -lc 'echo ${GH_TOKEN-unset}; gh auth status'   # → unset; not logged in
```

Drive one-liners from the host with `./shell.sh zsh -lc '…'` — `sh -lc` lacks the npm-global bin on PATH, so `claude` isn't found there.
