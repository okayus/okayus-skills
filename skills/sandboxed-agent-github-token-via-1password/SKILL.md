---
name: sandboxed-agent-github-token-via-1password
description: Let a sandboxed coding agent (Claude Code in the docker sandbox) push branches and open PRs itself, by injecting a GitHub fine-grained PAT scoped to ONE repository from 1Password at container start (`op run --env-file -- docker compose up`) — the lighter alternative to sandboxed-agent-git-relay (no host timer, no GitHub App) when a repo-scoped, expiring credential inside the boundary is an acceptable trade. Use when the relay feels heavy, when the agent needs `gh pr create` / `gh pr checks` directly, when in-container pushes start failing with `401` after a quiet token expiry, or when `docker compose up` warns that the GH_TOKEN variable is not set. Covers why it must be your own fine-grained PAT (a bot account is out), the permission set (no Workflows), the env-only credential helper, the fail-closed compose passthrough, the allow/deny rules that replace the blanket `git push` deny, the rulesets that stay the real guard, merge policy, rotation, and the service-account variant.
license: MIT
compatibility: Designed for Claude Code and similar agents. Host = Linux/macOS with Docker Compose v2, 1Password CLI (`op`) and a 1Password account; the claude-code-docker-sandbox layout (`.docker/`, `docker-compose.yml` + gitignored override, bind-mounted repo sharing `.git` with the host); the container image already has git + gh. Repo on GitHub owned by you (personal account, or an org you are a member of) — fine-grained PATs can't be used by outside collaborators.
metadata:
  author: okayus
  version: "0.1.0"
---

# Sandboxed-agent GitHub token via 1Password (repo-scoped PAT, injected at start)

Get the sandbox to the state where **the agent runs `git push origin claude/<topic>` and `gh pr create` itself**, and the only credential inside the container is a GitHub **fine-grained PAT that can reach one repository, cannot touch workflow files, expires, and is resolved from 1Password at `docker compose up`** — never written to disk on the host or in the container.

Written ahead of production, 2026-08-22, as the lighter replacement for [`sandboxed-agent-git-relay`](../sandboxed-agent-git-relay/SKILL.md) (in production on mazuoboeru since 2026-06). Facts about GitHub fine-grained PATs, 1Password CLI and Docker Compose were verified against their docs on 2026-08-22; the wiring itself has not run yet — see *Unverified claims* and write back.

**The trade in one sentence**: the relay keeps every credential *outside* the boundary and pays for it with moving parts (systemd timer, relay script, GitHub App key, `Relay-Merge` trailer, squash-residue guards); this skill puts a **narrowly scoped** credential *inside* the boundary and pays for it with a residual risk — a compromised sandbox can push to non-protected branches and open / merge PRs that pass CI on that one repo, until you revoke the token.

## When to use this skill

- The relay works but its machinery costs more than it protects for a solo project, and you want the agent to push / PR with plain `git` and `gh`
- The agent needs `gh pr create`, `gh pr view`, `gh pr checks` directly instead of unauthenticated `curl`
- You are choosing how a new sandbox authenticates to GitHub and the rule is "a credential may be inside, but only one repo's worth"

Do **not** use for:
- Projects whose rule is "no plaintext credential in the sandbox" — that is the relay's job, keep it
- Repositories where you are an **outside or repository collaborator** — GitHub documents that fine-grained PATs can't contribute there (a GitHub App / the relay is the option)
- Org repositories with a PAT policy that blocks fine-grained tokens, or anything multi-org

## Decision: relay vs token-in-sandbox

| | `sandboxed-agent-git-relay` | this skill |
|---|---|---|
| Credential in the sandbox | none | one fine-grained PAT, env only |
| Moving parts | systemd timer + `relay.mjs` + App private key on the host | `op run` wrapper + compose override |
| Who pushes / opens PRs | the relay, as the App (bot author) | the agent, **as you** |
| Policy enforcement | relay code outside the boundary + ruleset | **ruleset + token scope**; Claude Code allow/deny rules are convenience, not a boundary |
| Merge | `Relay-Merge: yes` trailer → relay merges after CI | human merges by default; opt-in `gh pr merge --auto` by the agent |
| CI status from the sandbox | unauthenticated `curl` | `gh pr checks` (fine-grained PATs can't call the Checks REST API — see pitfalls) |
| Workflow-file edits | refused (App lacks `workflows`) | refused (token lacks `workflows`) — same deliberate gap |
| Misconfiguration shows as | `REFUSE` lines in the journal | push `401/403`, or no `GH_TOKEN` at all → fail closed |

## Why it must be *your* fine-grained PAT

GitHub's limitations list (verified 2026-08-22) rules out the tempting alternatives:

- **A bot account added as collaborator** — "Using fine-grained personal access token to contribute to repositories where the user is an outside or repository collaborator" is unsupported. So the token is minted on **your** account, and it "has the same capabilities … that the owner of the token has, and is further limited by any scopes or permissions granted to the token" → **the ruleset must have `bypass_actors: []`**, or your admin bypass is the token's bypass.
- **A classic PAT** — `repo` scope is every repository you can reach. Never.
- **A GitHub App token minted inside** — needs the App private key inside the sandbox, which mints tokens for every installation repo. Worse than the PAT.
- **A deploy key** — can push, cannot open PRs (no API).

Token shape: resource owner = you; Repository access = **Only select repositories** → the one repo; permissions **Contents: Read and write**, **Pull requests: Read and write** (Metadata: Read comes along), optionally **Actions: Read** for `gh run view`; **no Workflows** — the agent must not be able to edit its own CI gate; expiry **90 days** (infinite is allowed by GitHub but defeats the point). Full click-path in [references/token-and-1password-setup.md](references/token-and-1password-setup.md).

## Deliverables (completion criteria)

- [ ] Fine-grained PAT exists with exactly the scope above; its expiry date is in the 1Password item (`expires`) and in your calendar
- [ ] The token lives only in 1Password (`op read "op://<vault>/<item>/credential"` works); it was never pasted into a file, a compose file, or a shell history
- [ ] `op` is installed on the host with desktop-app integration (or you accept `eval $(op signin)` every 30 min)
- [ ] `.docker/sandbox.env` (gitignored) holds the secret **reference**, `.docker/sandbox.env.example` (committed) the key; `./up.sh` wraps `op run --env-file=.docker/sandbox.env -- docker compose up -d`
- [ ] `docker-compose.override.yml` passes `GH_TOKEN` through; a plain `docker compose up -d` (no `op run`) leaves the container with **no** token and pushes fail (fail closed)
- [ ] The container's startup command sets an **inline, env-reading** git credential helper and a distinguishable git identity — no token on disk
- [ ] `.claude/settings.json` no longer denies `Bash(git push:*)` (a broad deny beats every allow); it allows `git push origin claude/*` + `gh pr create/view/checks` and denies force pushes, pushes to `main`, remote branch deletion, `gh pr merge`, `gh auth`, `gh api` (in the container's `bypassPermissions` default only the denies bite; the allows serve host / non-bypass sessions)
- [ ] Ruleset on `main`: PR + required check + `non_fast_forward` + `bypass_actors: []` (the `cloudflare-workers-builds-keyless-deploy` ruleset); optional second ruleset `~ALL` branches: `non_fast_forward`
- [ ] `CLAUDE.md` states the convention: work on `claude/<topic>`, push + `gh pr create`, never merge (or the opt-in rule below)
- [ ] E2E: in-container commit → `git push origin claude/e2e` → `gh pr create --fill` → `gh pr checks` shows CI; `gh pr merge` is refused by the deny rule; a push to `main` is refused by GitHub
- [ ] If migrating from the relay: timer disabled, App kept as the revert path, `Relay-Merge` convention removed from `CLAUDE.md`
- [ ] Every `UNVERIFIED:` bullet below checked on the real setup and written back

## Architecture in one screen

```
host     ./up.sh  =  op run --env-file=.docker/sandbox.env -- docker compose up -d
           │         (1Password unlock once; GH_TOKEN="op://<vault>/<item>/credential" → real value, env only)
           └─ compose override:  environment: { GH_TOKEN: }   ← passthrough; unset on the host = absent in the container
container  GH_TOKEN in process env only
           ├─ git   credential.helper = inline sh that echoes $GH_TOKEN   (nothing under ~/.git-credentials)
           ├─ gh    reads GH_TOKEN itself ("takes precedence over previously stored credentials")
           └─ Claude Code  allow: git push origin claude/*, gh pr create|view|checks   deny: --force, main, --delete, gh pr merge, gh auth, gh api
GitHub   fine-grained PAT → ONE repo · Contents + Pull requests · no Workflows · 90-day expiry
         rulesets: main = PR + required check + no force + bypass_actors: []   (optional: ~ALL = no force push)
```

| Layer | Owns | Must not do |
|---|---|---|
| 1Password item | the only copy of the token, its expiry | be read by anything but `op run` / `op read` on the host |
| `op run` + compose passthrough | token → container env, once per `up` | write the value into a file or the committed compose |
| git credential helper | answer `git push` from `$GH_TOKEN` | persist (`store` / `cache` helpers are out) |
| `gh` | API calls with `GH_TOKEN` | `gh auth login` (would write a token to `~/.config/gh/hosts.yml` on disk) |
| Claude Code rules | keep the *well-behaved* agent on `claude/*` and off merge | be mistaken for the security boundary |
| ruleset + token scope | the boundary: what a **compromised** sandbox can still do | — |

## Setup

Human steps once; copy-ready files in the references.

1. **Mint the token** on GitHub (scope above) and paste it straight into 1Password: `op item create --category "API Credential" --title "github-pat-<repo>-sandbox" --vault "<vault>" 'credential=<token>' 'expires=<YYYY-MM-DD>' …` — then close the GitHub tab; the token now exists in exactly one place. [references/token-and-1password-setup.md](references/token-and-1password-setup.md)
2. **`op` on the host**: install from 1Password's apt repo; enable *Settings → Security → Unlock using system authentication* and *Settings → Developer → Integrate with 1Password CLI* so `op run` unlocks with the desktop app instead of a master-password prompt (without the app: `eval $(op signin)`, 30-minute session).
3. **Env template + wrapper**: `.docker/sandbox.env` = `GH_TOKEN="op://<vault>/github-pat-<repo>-sandbox/credential"` (gitignored — it is a reference, but host-specific); `up.sh` = `exec op run --env-file=.docker/sandbox.env -- docker compose up -d "$@"`.
4. **Compose**: in the gitignored `docker-compose.override.yml`, `environment: { GH_TOKEN: }` (no value = resolved from the `docker compose` process environment, i.e. from `op run`; absent → "variable is not set" warning and the container simply has no token). In the committed `docker-compose.yml` `command`, add the inline credential helper + identity lines (mind compose's `$$` escaping). [references/compose-and-git-wiring.md](references/compose-and-git-wiring.md)
5. **Claude Code rules**: replace `"Bash(git push:*)"` in `deny` with the targeted list; add the `git push origin claude/*` and `gh pr …` allows. Same reference.
6. **Rulesets**: `main` per the keyless-deploy skill; optionally `~ALL` no-force. [references/rulesets-and-policy.md](references/rulesets-and-policy.md)
7. **`CLAUDE.md`**: the branch / PR / no-merge convention, and "the token is the project's, not yours — don't print it, don't `gh auth login`".
8. **E2E** (below), then record what differed in *Unverified claims*.

## The fail-closed property (why `op run` is the only door)

Compose drops a valueless `environment` key that the shell doesn't provide ("If the value is not resolved, the variable is unset and is removed from the service container environment" — verified 2026-08-22). So every way of starting the container *without* going through 1Password — `docker compose up -d` by hand, a restart after `down`, a CI runner — yields a sandbox that can still commit but **cannot push**: `git push` gets `401`, `gh` says it is not logged in. There is no default token, no cached token, no file to fall back to. `docker compose restart` keeps the env of the existing container; `down` + `up` needs `./up.sh` again.

## Merge policy (the one decision the relay made for you)

- **Default — human merges.** `deny: Bash(gh pr merge *)`; the agent ends its work at "PR open, CI green, here is the URL". Reviewing and merging on the host is the governance step, exactly as with the relay without the trailer.
- **Opt-in — agent-initiated merge.** Allow `Bash(gh pr merge --auto --squash *)` only; enable *Allow auto-merge* in the repo settings. `--auto` is the explicit, auditable signal (it shows in the PR timeline) and GitHub merges only once the ruleset's required checks pass — the same semantics the `Relay-Merge: yes` trailer had, minus the relay. Don't allow a bare `gh pr merge`, which merges immediately when checks already pass.
- Either way the agent **cannot approve** its own PR (same account), so `required_approving_review_count` stays `0` for a solo repo — a required review would make every PR unmergeable by anyone.

## What a compromised sandbox can do now (be honest with yourself)

| Can | Cannot |
|---|---|
| push any commit to any **non-protected** branch of the one repo (incl. overwriting other `claude/*` branches unless the `~ALL` no-force ruleset exists) | push to `main` (ruleset, no bypass), force-push `main`, delete `main` |
| open / edit / close PRs and comments, as you | edit `.github/workflows/**` (no `workflows` permission — GitHub rejects the push) |
| merge a PR whose required checks pass (`contents: write` covers the merge API; the `gh pr merge` deny stops the well-behaved agent, not a malicious dependency) | touch any other repository, gists, packages, org settings |
| read the one repo (and every public repo) | outlive the expiry, or survive a revoke |

If the "merge a CI-green PR" row is unacceptable, that is the line where the relay (policy outside the boundary) is the right tool, not a stricter deny list. Mitigations that *do* work here: strong required checks (tests), reviewing PRs before merging, short expiry, revoke-on-suspicion.

## Ops

- **Rotation** (every 90 days, or on suspicion): GitHub → the token → *Regenerate* → `op item edit "github-pat-<repo>-sandbox" 'credential=<new>' 'expires=<date>'` → `./up.sh` (compose recreates the container when the env value changes) → delete the old token on GitHub if regenerate didn't.
- **Expiry**: the first symptom is `git push` → `401` / `remote: Invalid username or token` in the container. Check `op item get … --fields label=expires` before debugging anything else.
- **Revoke on incident**: delete the token on GitHub (instant, global), `docker compose down`, inspect the repo's recent pushes / PRs / merges with `gh api repos/<o>/<r>/events` from the host.
- **Host visibility**: `docker inspect <container>` shows the env value — the host is trusted. Nothing persists it: the only named volumes are `~/.claude` and the shell history, and nothing writes the token to either.
- **Never**: `gh auth login` in the container (writes the token to `~/.config/gh/hosts.yml` — container layer, so it survives `stop`/`start`/`restart` and only dies on `down`; a token on disk is exactly what this design avoids), `git config credential.helper store`, `echo $GH_TOKEN` in a transcript, the token on a `git push https://x-access-token:…@github.com/…` URL (ends up in `.git/config` / history).

Runbooks, the relay-migration checklist and the threat model in full: [references/rulesets-and-policy.md](references/rulesets-and-policy.md).

## E2E acceptance test

1. `./up.sh` → the container starts; in-container `gh auth status` reports the token from `GH_TOKEN` (env), `echo ${#GH_TOKEN}` prints a length, `git config --global credential.helper` prints the inline helper.
2. In-container: `git switch -c claude/e2e-token`, a doc tweak, commit (author shows the sandbox identity), `git push -u origin claude/e2e-token` → accepted; `gh pr create --fill` → PR URL; `gh pr checks --watch` → CI result.
3. Negative checks: `git push origin HEAD:main` → rejected by GitHub (ruleset); `gh pr merge` → blocked by the deny rule; a commit touching `.github/workflows/ci.yml` → push rejected for lack of `workflows` permission.
4. Fail-closed: `docker compose down && docker compose up -d` (no `op run`) → `gh auth status` says not logged in, `git push` → `401`. Then `./up.sh` to restore.
5. On the host: merge the PR, confirm `delete_branch_on_merge` removed the remote branch; in-container `git fetch --prune`.

## The pitfalls that eat hours

- **`Bash(git push:*)` left in `deny`** → every push blocked no matter what you allow ("a deny rule can't carry allowlist exceptions"). Replace it with the targeted denies.
- **`git push -u origin claude/x` doesn't match `Bash(git push origin claude/*)`** → the flag sits before `origin`; add the `-u` form (and expect prompts for other flag orders — argument-constraining patterns are documented as fragile; the ruleset is the guard). Note the scope of the allow list: "Allow rules have no effect in `bypassPermissions`" (permission-modes docs), which is the container's default — inside, only the **deny** list acts; the allows matter for host / non-bypass sessions on the same repo.
- **`$GH_TOKEN` written as `$GH_TOKEN` in `docker-compose.yml`** → compose interpolates it at parse time (empty). Write `$$GH_TOKEN` so the container's shell sees `$GH_TOKEN`.
- **Reading CI with `gh api …/check-runs`** → `gh api` is denied by the template (the merge endpoint is one `PUT` away), and even where allowed, fine-grained PATs can't call the Checks REST API. Read CI with `gh pr checks` (GraphQL), or the relay's unauthenticated `curl` on a public repo.
- **"GH_TOKEN variable is not set" warning on `docker compose up`** → you skipped `./up.sh`; by design the container is tokenless now.
- **Pushes start failing with 401 one morning** → the token expired; 1Password `expires` first, GitHub second.
- **`gh auth setup-git` inside the container** → adds gh as a credential helper too; harmless with `GH_TOKEN`, but it's one more path — keep the inline helper as the only one.
- **Token in a remote URL** → `git remote set-url` with `https://x-access-token:<token>@…` lands in `.git/config`, which the host shares and `git remote -v` prints. Never.
- **Leftover local `claude/*` branches** → no relay reaps them; `git fetch --prune` after merges, and `delete_branch_on_merge=true` on the repo.
- **Assuming the `~ALL` no-force ruleset blocks squash merges** → it doesn't (a merge is a fast-forward of `main`); it only blocks rewriting pushed branches.

## Unverified claims — confirm while implementing, then write back

- UNVERIFIED: the inline credential helper survives compose's quoting (`sh -c "… '!f() { echo username=x-access-token; echo \"password=$$GH_TOKEN\"; }; f' …"`) — if not, bake `/usr/local/bin/git-credential-env` into the image (script in the wiring reference) and point `credential.helper` at it.
- UNVERIFIED: `docker compose up -d` under `op run` leaves the token in the running container after `op run` exits (it should — env is fixed at container creation), and a changed token value makes `up -d` recreate the container.
- UNVERIFIED: `gh pr checks` / `gh pr view` / `gh pr create` all work with a fine-grained PAT holding only Contents + Pull requests (+ Metadata) — GraphQL is not on GitHub's unsupported list, the Checks REST API is.
- UNVERIFIED: the `API Credential` category's field is named `credential` for `op read` / `op item create` — confirm with `op item get <item> --format json`.
- UNVERIFIED: Claude Code matches `Bash(git push origin claude/*)` against `git push origin claude/x` and also against a refspec like `claude/x:refs/heads/main` (the ruleset, not the rule, must stop the latter) — record the observed prompts.
- UNVERIFIED: 1Password desktop-app integration on this Ubuntu host ("Unlock using system authentication") makes `op run` prompt-free; otherwise the `eval $(op signin)` session workflow applies.
- UNVERIFIED: the exact `remote rejected` line GitHub prints when a fine-grained PAT without the `workflows` permission pushes a `.github/workflows/**` change (the classic-PAT wording says `without workflow scope`; the fine-grained one may name the permission) — capture it in E2E step 3 and put it in the setup reference.
- UNVERIFIED: the in-container service-account variant — the 1Password domains the egress firewall needs and the per-push request budget (the support page listing domains returned 403 to the fetch on 2026-08-22). See [references/service-account-variant.md](references/service-account-variant.md).

## Scope boundary — what this skill does NOT cover

- The credential-free design (policy outside the boundary, GitHub App, `Relay-Merge`) — `sandboxed-agent-git-relay`
- The container, firewall, named volumes, `bypassPermissions` default — `claude-code-docker-sandbox`
- The committed permission allowlist and the docs MCP — `cloudflare-mcp-claude-tooling` (this skill only changes the git / gh entries)
- The `main` ruleset JSON — `cloudflare-workers-builds-keyless-deploy` `references/ruleset.md`
- Application-level PATs issued by your own app to CLIs / agents — `cloudflare-workers-pat-bearer-auth` (different token, different threat model)
- Cloudflare credentials in the sandbox — none by design (Workers Builds keyless deploy); don't extend this pattern to them without the same "one resource, short expiry" discipline
- Multi-repo sandboxes, org PAT policies, GitHub Enterprise

## References

- [references/token-and-1password-setup.md](references/token-and-1password-setup.md) — fine-grained PAT click-path and permission table, `op` install + app integration, `op item create`, env template, `up.sh`
- [references/compose-and-git-wiring.md](references/compose-and-git-wiring.md) — compose override passthrough, the startup-command lines (credential helper + identity, `$$` escaping), the baked-script alternative, `.claude/settings.json` allow/deny, `CLAUDE.md` paragraph, in-container verification
- [references/rulesets-and-policy.md](references/rulesets-and-policy.md) — `main` + `~ALL` rulesets, merge policy options, threat model, rotation / expiry / revoke runbooks, migrating off the relay
- [references/service-account-variant.md](references/service-account-variant.md) — `op` inside the container with a vault-scoped service account: when it's worth it, setup, trade-offs
