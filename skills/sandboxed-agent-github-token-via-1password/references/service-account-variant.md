# Variant: `op` inside the container with a vault-scoped service account

Not the default. Read this only if one of these is true:

- you want to rotate the GitHub token **without recreating the container** (the helper resolves it on every push);
- several tokens / secrets must reach the sandbox and you'd rather manage one 1Password vault than several env passthroughs;
- the host can't run `op` interactively (headless box, CI) but a service account token can be provisioned to it.

What you pay: a **second secret in the container** (`OP_SERVICE_ACCOUNT_TOKEN`, which reads the whole vault it is scoped to), **egress to 1Password** from the sandbox, and 1Password's service-account **rate limits** on every push. The host-side `op run` injection needs none of these.

## Setup

1. **A dedicated vault** — service accounts "can't [be granted] access to your built-in Personal, Private, or Employee vault, or your default Shared vault" (docs, 2026-08-22). Create `Sandbox-<project>` and move the `github-pat-<repo>-sandbox` item there. Nothing else goes in it.
2. **Create the service account**, read-only on that one vault, with an expiry:

   ```sh
   op service-account create "<project>-sandbox" --expires-in 90d --vault "Sandbox-<project>:read_items"
   ```

   The token is printed **once** — "1Password CLI only returns the service account token once. Save the token in 1Password immediately" — as a second item in your Private vault (not in the sandbox vault: that would let the service account read itself).
3. **Inject `OP_SERVICE_ACCOUNT_TOKEN`** into the container the same way this skill injects `GH_TOKEN`: `.docker/sandbox.env` → `OP_SERVICE_ACCOUNT_TOKEN="op://Private/<project>-sandbox-service-account/credential"`, compose override passthrough `OP_SERVICE_ACCOUNT_TOKEN:`. Remove `GH_TOKEN` from the env.
4. **Install `op` in the image** (build-time network is open; the runtime firewall isn't involved): add the apt-repo block from `token-and-1password-setup.md` to `.docker/Dockerfile` (as root, before `USER node`) and rebuild (`docker compose down && docker compose build && docker compose up -d`, no `-f`).
5. **Credential helper resolves on demand**:

   ```sh
   git config --global credential.helper '!f() { echo username=x-access-token; echo "password=$(op read op://Sandbox-<project>/github-pat-<repo>-sandbox/credential)"; }; f'
   ```

   and for `gh`, a wrapper in `/usr/local/bin/gh` that exports `GH_TOKEN="$(op read …)"` before exec'ing the real binary (or just set `GH_TOKEN` once per shell). Budget: **one `op read` = 3 read requests** (so does `op item get`; `op item list` = 1 + 1 per vault), and non-Business plans get **1,000 reads / hour / token** — roughly 330 pushes an hour, plenty for one agent, but a `gh` wrapper that resolves on every invocation eats it quickly (1Password service-account docs + rate-limits page, 2026-08-22).
6. **Egress**: the firewall's allowlist must include the 1Password endpoints the CLI talks to. **UNVERIFIED** — the 1Password support page listing domains returned HTTP 403 to the docs fetch on 2026-08-22; determine them empirically (`op read` inside the container with the firewall's log / `tcpdump`, expect the account sign-in host such as `my.1password.com` plus related `*.1password.com` hosts) and add them to the **fatal** list (a push must not silently fall back). Record the list here.
7. **Claude Code rules**: add `Bash(op read *)` to `allow` **only** for the helper's path if prompts appear; deny `Bash(op item *)`, `Bash(op vault *)`, `Bash(op signin *)` — the sandbox has no business enumerating the vault.

## Trade-offs, concretely

| | host `op run` (default) | in-container service account |
|---|---|---|
| Secrets inside the container | the GitHub token (env) | the service-account token (env) — reads the whole sandbox vault |
| Rotation | `./up.sh` (container recreate) | edit the 1Password item; next push picks it up |
| Egress | none beyond GitHub | + 1Password API hosts (fatal allowlist) |
| Rate limits | none | per service account: `op read` = 3 read requests; non-Business plans 1,000 reads / hour / token (≈ 330 pushes / hour) |
| Host requirement | interactive `op` (app integration or `op signin`) | none at runtime (token provisioned once) |
| Failure when 1Password is unreachable | none at runtime | every push fails (fail closed, noisily) |

Verdict: stay on the default unless rotation-without-restart or headless hosts are a real requirement.
