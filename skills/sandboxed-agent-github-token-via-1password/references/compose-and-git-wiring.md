# Compose passthrough, git / gh wiring, Claude Code rules

## `docker-compose.override.yml` (gitignored, host-specific)

```yaml
# LOCAL-ONLY override — gitignored. Auto-loaded only when you run `docker compose`
# from the project dir WITHOUT -f (the claude-code-docker-sandbox skill's trap).
services:
  dev:
    environment:
      # No value = resolved from the environment of the `docker compose` process,
      # i.e. from `op run` in ./up.sh. Unset on the host → "variable is not set"
      # warning and the key is REMOVED from the container env (fail closed).
      GH_TOKEN:
    volumes:
      - ../okayus-skills/skills:/home/node/.claude/skills:ro   # if you use the skills mount
```

Mapping form (`GH_TOKEN:`) rather than the list form (`- GH_TOKEN`) so it merges cleanly with the base file's mapping-style `environment`.

## `docker-compose.yml` startup command — credential helper + identity

Add to the `command:` chain of the committed compose file (before `exec sleep infinity`). The helper is inert without a token, so it is safe in the distributed file.

```yaml
    command: >
      sh -c "sudo /usr/local/bin/init-firewall.sh &&
             (npm i -g @anthropic-ai/claude-code@latest pnpm@9.15.0 ||
              echo 'WARN: claude/pnpm update failed; using image-baked versions') &&
             (git config --global credential.helper '!f() { echo username=x-access-token; echo \"password=$$GH_TOKEN\"; }; f' &&
              git config --global user.name 'Claude (<project> sandbox)' &&
              git config --global user.email 'claude-sandbox@users.noreply.github.com' ||
              echo 'WARN: git credential/identity setup failed') &&
             ([ -s /home/node/.claude/settings.json ] || echo '{}' > /home/node/.claude/settings.json) &&
             (jq '.permissions.defaultMode = \"bypassPermissions\"' /home/node/.claude/settings.json > /tmp/cs.json &&
              mv /tmp/cs.json /home/node/.claude/settings.json ||
              echo 'WARN: could not set bypassPermissions default') &&
             exec sleep infinity"
```

Three details:

- **`$$GH_TOKEN`**, not `$GH_TOKEN`: compose interpolates `$VAR` in the YAML at parse time; `$$` yields a literal `$` so the *container's* shell expands it when git calls the helper.
- The helper is the relay's (`relay.mjs`: `credential.helper=!f() { echo username=x-access-token; echo "password=$GIT_RELAY_TOKEN"; }; f`) with the env var renamed. `x-access-token` is accepted as the username for token auth over HTTPS; the token is the password. Nothing is written under `~/.git-credentials`, and `~/.gitconfig` lives in the container layer (re-created each start), not in a named volume.
- The identity makes sandbox commits distinguishable in `git log` / PR history from your host commits — same convention as the relay's step 7.

If the quoting fights you (UNVERIFIED: it has not been run through compose), bake a script instead and point the helper at it:

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
      "Bash(gh run list:*)",
      "Bash(gh run view:*)"
    ],
    "deny": [
      // NOT "Bash(git push:*)" — a broad deny beats every allow above.
      "Bash(git push * --force*)",
      "Bash(git push --force*)",
      "Bash(git push -f *)",
      "Bash(git push * main)",
      "Bash(git push * --delete *)",
      "Bash(gh pr merge *)",          // drop this line (and add the --auto form to allow) for opt-in agent merges
      "Bash(gh auth *)",              // no `gh auth login` (stores a token), no `gh auth token` (prints it)
      "Bash(gh api *)"                // the merge endpoint is one PUT away; read CI via `gh pr checks`
    ]
  },
  "enableAllProjectMcpServers": false
}
```

Rules to keep in mind (Claude Code permissions docs, 2026-08-22): a deny rule matches regardless of a narrower allow; `*` spans spaces, so `Bash(git push origin claude/*)` also matches `git push origin claude/x:main` — **the ruleset rejects that push, the rule doesn't**; patterns constraining arguments are documented as fragile; deny rules still apply in `bypassPermissions` mode while **allow rules have no effect there** (permission-modes docs) — so inside the container (bypass by default) only the `deny` list acts, and the `allow` list is for host / non-bypass sessions on the same repo. Treat this list as keeping the well-behaved agent on the rails, nothing more.

Opt-in agent merge: replace the `gh pr merge` deny with `"Bash(gh pr merge --auto --squash *)"` in `allow` and enable *Allow auto-merge* on the repo (see `rulesets-and-policy.md`).

## `CLAUDE.md` paragraph for the project

> **git in the sandbox**: commit on `claude/<topic>`, `git push -u origin claude/<topic>`, open the PR with `gh pr create --fill` and report the URL; watch CI with `gh pr checks`. Never merge (the human merges from the host) / or: signal a merge only with `gh pr merge --auto --squash` when you are confident. The `GH_TOKEN` in this container is the project's repo-scoped token — don't print it, don't `gh auth login`, don't put it in a URL. `.github/workflows/**` changes are pushed by the human (the token has no `workflows` permission).

## In-container verification

```sh
gh auth status                                  # → Logged in … Token: GH_TOKEN env
echo "${#GH_TOKEN}"                             # a length, never the value
git config --global credential.helper           # the inline helper
git ls-remote --heads origin | head -3          # read works
git switch -c claude/e2e-token && git commit --allow-empty -m "chore: e2e token push" && git push -u origin claude/e2e-token
gh pr create --fill && gh pr checks --watch
git push origin HEAD:main                       # → rejected by the ruleset (expected)
```
