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
| — | **Workflows: none** | the agent must not be able to edit `.github/workflows/**`; GitHub rejects such pushes at the remote: `! [remote rejected] … (refusing to allow a Personal Access Token to create or update workflow \`.github/workflows/ci.yml\` without \`workflow\` scope)` (verified 2026-08-22 — same wording as for classic PATs) — the same deliberate gap the relay keeps |

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

Without the app: `eval $(op signin)` in the same shell (the session env var is per shell, TTL ~30 minutes) — acceptable for a once-a-day `./shell.sh`, annoying if you open shells all day (that is the one real cost of exec-time injection).

## 3. Store the token as the only copy

```sh
op item create --category "API Credential" --vault "<vault>" \
  --title "github-pat-<repo>-sandbox" \
  'credential=<paste the token>' \
  'hostname=github.com' \
  'expires=<YYYY-MM-DD>' \
  'notesPlain=repo <owner>/<repo>; Contents + Pull requests write; no Workflows; injected per shell by ./shell.sh'
```

- **One item title per repository** (`github-pat-<repo>-sandbox`). Reusing a title for a second project makes `op read "op://<vault>/<title>/credential"` ambiguous and can inject the *other* project's token — it happened when a second project's `op item create` was copy-pasted with the old `--title`. Before the first `./shell.sh`: `op item list --vault <vault> | grep github-pat-`.
- Prefer a dedicated vault (e.g. `Sandbox`) over your Private vault: it keeps the service-account variant possible later (service accounts can't read Private vaults) and makes "what can the sandbox reach" a one-vault question.
- Confirm the field name before wiring anything: `op item get "github-pat-<repo>-sandbox" --format json | jq '.fields[] | {id,label,type}'` — the API Credential category names it `credential` (confirmed on mazuoboeru and kokemusu, 2026-08-22) — still worth one look before wiring.
- Smoke: `op read "op://<vault>/github-pat-<repo>-sandbox/credential" | wc -c` → a length, not the token, in your terminal.
- Paste the token into the item **directly from the GitHub page**; don't route it through a file or the clipboard manager's history if you can avoid it.

## 4. Env template (reference only — safe to keep out of git anyway)

`.docker/sandbox.env` (gitignored; host-specific vault/item names):

```
# Read by ./shell.sh on the host (`op read`), per shell, never in the container
# config. This file holds a 1Password secret REFERENCE, never a value.
# Copy from sandbox.env.example.
GH_TOKEN="op://<vault>/github-pat-<repo>-sandbox/credential"
```

`.docker/sandbox.env.example` (committed): the same line with placeholders.

`.gitignore` additions:

```
.docker/sandbox.env
docker-compose.override.yml     # already there if you use the skills mount
```

## 5. The wrappers: `up.sh` and `shell.sh`

Full copy-ready files, with the reasoning for every flag, are in [compose-and-git-wiring.md](compose-and-git-wiring.md). The split in one line each:

```sh
# up.sh — starts the container. No credential, idempotent, safe to run repeatedly.
exec docker compose up -d "$@"

# shell.sh — the ONLY door the token comes through, into this shell and its children.
# NOT `op run -- docker exec`: op run interposes on stdout/stderr and breaks the tty.
GH_TOKEN=$(op read "op://<vault>/github-pat-<repo>-sandbox/credential"); export GH_TOKEN
[ -t 0 ] && [ -t 1 ] && TT=-it || TT=-i     # -t only with real terminals on both ends
exec docker exec $TT -e GH_TOKEN <container> "$@"
```

`chmod +x up.sh shell.sh`. Run them from the project directory **without `-f`** so `docker-compose.override.yml` (the skills mount) is auto-loaded — the `-f` trap from `claude-code-docker-sandbox`.

`op read` resolves one `op://` reference and writes that secret to stdout, so `GH_TOKEN=$(op read …)` puts it in the script's environment and nowhere else; `docker exec -e GH_TOKEN` then forwards it by name into the exec'd process. When the shell exits, the token is gone from the container entirely.

Why not `op run --env-file=… -- docker exec …`, which reads more naturally? Because `op run` "loads the specified secrets, then runs the provided command in a subprocess with the secrets made available as environment variables only for the duration of the process" **and conceals secrets printed to that subprocess's stdout/stderr** — it interposes on those streams, so an interactive `docker exec -it` underneath never holds the real terminal (broken prompt, 80x24 pty; kokemusu, 2026-08-23). `op run` is still fine for non-interactive commands; `op read` is fine for both, so this skill uses `op read` everywhere.

Note the consequence either way: **an agent cannot re-open its own tokened shell** — `op` has no session in a non-interactive agent shell — which is the intended human checkpoint, not a bug to route around.

Verify on the host without printing the value:

```sh
op read "op://<vault>/github-pat-<repo>-sandbox/credential" | wc -c    # → 94 (93 + newline)
op run --env-file=.docker/sandbox.env -- sh -c 'echo "GH_TOKEN length: ${#GH_TOKEN}"'   # also fine (non-interactive)
```

Do **not** verify with `op run … -- env`: 1Password conceals any output matching an injected secret, so the line reads `GH_TOKEN=<concealed by 1Password>` — exactly 24 characters, which looks like a truncated 93-character token. A length or a byte count can't match the secret, so it is not concealed. (That same concealing is why `op run` must not wrap the interactive `docker exec` — see above.)
