# The token, 1Password, and the host-side wrapper

Everything here happens once, on the host, by a human. Sources checked 2026-08-22: GitHub "Managing your personal access tokens", 1Password "Get started with 1Password CLI", "Secrets in environment variables".

## 1. Mint the fine-grained PAT (GitHub)

Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → *Generate new token*.

| Field | Value | Why |
|---|---|---|
| Token name | `<repo>-sandbox` | greppable in GitHub's token list and audit log |
| Resource owner | **you** (the repo owner, or the org you belong to) | fine-grained PATs don't work for outside / repository collaborators — a separate bot account cannot hold this token |
| Expiration | **90 days** | GitHub allows infinite lifetimes; don't. The date goes into the 1Password item and your calendar |
| Repository access | **Only select repositories** → the one repo | "All repositories" turns a sandbox compromise into an account compromise |
| Repository permissions | **Contents: Read and write** (push, branches, merges) · **Pull requests: Read and write** (open / edit PRs) · *Metadata: Read* (added automatically) · optional **Actions: Read** (`gh run view`) | the minimum for push + PR |
| — | **Workflows: none** | the agent must not be able to edit `.github/workflows/**`; GitHub rejects such pushes at the remote (`refusing to allow a Personal Access Token to create or update workflow …` — record the exact fine-grained wording from E2E step 3 here; the classic-PAT message ends in `without workflow scope`) — the same deliberate gap the relay keeps |

Notes:

- "Tokens always include read-only access to all public repositories on GitHub" — expected, harmless.
- The token inherits **your** capabilities, limited by the permissions above. Your admin rights do **not** let it bypass a ruleset whose `bypass_actors` is empty — keep it empty (see `rulesets-and-policy.md`).
- Copy the token once, straight into 1Password (step 3). Close the tab. If you lose it, *Regenerate*.

## 2. 1Password CLI on the host

Debian / Ubuntu, from 1Password's apt repository (verbatim from the docs, 2026-08-22):

```sh
curl -sS https://downloads.1password.com/linux/keys/1password.asc | \
  sudo gpg --dearmor --output /usr/share/keyrings/1password-archive-keyring.gpg && \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/$(dpkg --print-architecture) stable main" | \
  sudo tee /etc/apt/sources.list.d/1password.list && \
  sudo mkdir -p /etc/debsig/policies/AC2D62742012EA22/ && \
  curl -sS https://downloads.1password.com/linux/debian/debsig/1password.pol | \
  sudo tee /etc/debsig/policies/AC2D62742012EA22/1password.pol && \
  sudo mkdir -p /usr/share/debsig/keyrings/AC2D62742012EA22 && \
  curl -sS https://downloads.1password.com/linux/keys/1password.asc | \
  sudo gpg --dearmor --output /usr/share/debsig/keyrings/AC2D62742012EA22/debsig.gpg && \
  sudo apt update && sudo apt install 1password-cli
op --version
```

Unlock without typing the master password each time — **desktop-app integration** (Linux): 1Password app → *Settings → Security → Unlock using system authentication*, then *Settings → Developer → Integrate with 1Password CLI*. `op whoami` then succeeds without `op signin`.

Without the app: `eval $(op signin)` in the same shell (the session env var is per shell, TTL ~30 minutes) — acceptable for a once-a-day `./up.sh`, annoying otherwise.

## 3. Store the token as the only copy

```sh
op item create --category "API Credential" --vault "<vault>" \
  --title "github-pat-<repo>-sandbox" \
  'credential=<paste the token>' \
  'hostname=github.com' \
  'expires=<YYYY-MM-DD>' \
  'notesPlain=repo <owner>/<repo>; Contents + Pull requests write; no Workflows; used by ./up.sh'
```

- Prefer a dedicated vault (e.g. `Sandbox`) over your Private vault: it keeps the service-account variant possible later (service accounts can't read Private vaults) and makes "what can the sandbox reach" a one-vault question.
- Confirm the field name before wiring anything: `op item get "github-pat-<repo>-sandbox" --format json | jq '.fields[] | {id,label,type}'` — the reference below assumes the API Credential category names it `credential` (UNVERIFIED until you look).
- Smoke: `op read "op://<vault>/github-pat-<repo>-sandbox/credential" | wc -c` → a length, not the token, in your terminal.
- Paste the token into the item **directly from the GitHub page**; don't route it through a file or the clipboard manager's history if you can avoid it.

## 4. Env template (reference only — safe to keep out of git anyway)

`.docker/sandbox.env` (gitignored; host-specific vault/item names):

```
# Resolved by `op run` on the host at `docker compose up`. This file holds a
# 1Password secret REFERENCE, never a value. Copy from sandbox.env.example.
GH_TOKEN="op://<vault>/github-pat-<repo>-sandbox/credential"
```

`.docker/sandbox.env.example` (committed): the same line with placeholders.

`.gitignore` additions:

```
.docker/sandbox.env
docker-compose.override.yml     # already there if you use the skills mount
```

## 5. The wrapper: `up.sh`

```sh
#!/usr/bin/env sh
# Start the sandbox with the repo-scoped GitHub token resolved from 1Password.
# Any other way of starting the container (plain `docker compose up -d`) yields a
# container WITHOUT a token — by design (compose drops unresolved env keys).
set -eu
cd "$(dirname "$0")"
exec op run --env-file=.docker/sandbox.env -- docker compose up -d "$@"
```

`chmod +x up.sh`. Run it from the project directory **without `-f`** so `docker-compose.override.yml` (the `GH_TOKEN` passthrough and the skills mount) is auto-loaded — the `-f` trap from `claude-code-docker-sandbox`.

What `op run` does (docs): "loads the specified secrets, then runs the provided command in a subprocess with the secrets made available as environment variables only for the duration of the process". The process here is `docker compose up -d`, which hands the value to the container at creation and exits; the container keeps its environment.

Verify on the host without printing the value:

```sh
op run --env-file=.docker/sandbox.env -- sh -c 'echo "GH_TOKEN length: ${#GH_TOKEN}"'
```
