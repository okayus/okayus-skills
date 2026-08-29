---
name: sandboxed-agent-github-token-via-1password
description: Let a sandboxed coding agent (Claude Code in the docker sandbox) push branches and open PRs itself with a GitHub fine-grained PAT scoped to ONE repository, resolved from 1Password into the shell that runs it (`op read` the reference, then `docker exec -e GH_TOKEN`, wrapped in `./shell.sh`). Use when in-container pushes fail with `401` or `gh` is not logged in; when a plain `docker compose up -d` recreated the container and killed the agent session; when `docker inspect` shows a bare `GH_TOKEN` with no `=`; when a shell opened via `op run` has a broken prompt (raw `${...}` templates, pty stuck at 80x24); when the agent needs `gh pr create` / `gh pr checks` directly; or when choosing between this and sandboxed-agent-git-relay. Covers why it must be your own PAT, the permission set (no Workflows), the allow/deny rules replacing the blanket `git push` deny, the rulesets that stay the real boundary, merge policy, rotation, and the service-account variant.
license: MIT
compatibility: Designed for Claude Code and similar agents. Host = Linux/macOS with the Docker Compose plugin, 1Password CLI (`op`) and a 1Password account; the claude-code-docker-sandbox layout (`.docker/`, `docker-compose.yml` + gitignored override, bind-mounted repo sharing `.git` with the host); the container image already has git + gh. Repo on GitHub owned by you (personal account, or an org you are a member of) — fine-grained PATs can't be used by outside collaborators.
metadata:
  author: okayus
  version: "0.2.5"
---

# Sandboxed-agent GitHub token via 1Password (repo-scoped PAT, injected per shell)

Get the sandbox to the state where **the agent runs `git push origin claude/<topic>` and `gh pr create` itself**, and the only credential inside the container is a GitHub **fine-grained PAT that can reach one repository, cannot touch workflow files, expires, and is resolved from 1Password into the shell the agent runs in** — never written to disk on the host or in the container, and never part of the container's configuration.

Written ahead of production, 2026-08-22, as the lighter replacement for [`sandboxed-agent-git-relay`](../sandboxed-agent-git-relay/SKILL.md) (in production on mazuoboeru since 2026-06). Facts about GitHub fine-grained PATs, 1Password CLI and Docker Compose were verified against their docs on 2026-08-22; the wiring was first applied to mazuoboeru the same day (PR #88), then to kokemusu, where a day of running it moved the injection point — see *Verified on mazuoboeru* and *Verified on kokemusu* for what held, what surprised, and what is still open.

**Where the token enters — changed in 0.2.0.** `environment: { GH_TOKEN: … }` in the compose file was the original design; it is now the documented *alternative*, because a token in the compose file is part of the **container's configuration**. One plain `docker compose up -d` that doesn't go through `op run` then counts as a configuration change, and compose stops and **recreates** the container — dropping the token and killing every process inside, including a running agent session. The default is now **exec-time injection**: `./up.sh` is a credential-free, idempotent `docker compose up -d`, and `./shell.sh` resolves the token with `op read` and hands it to `docker exec -e GH_TOKEN <container> …`, putting it in that one shell and its children. Copy-ready files for both in [references/compose-and-git-wiring.md](references/compose-and-git-wiring.md).

**How `shell.sh` reaches 1Password — fixed in 0.2.1.** 0.2.0 wrapped the whole thing in `op run --env-file=… -- docker exec -it …`. Don't: `op run` conceals secrets on its child's stdout/stderr, which means it **interposes on those streams**, and an interactive `docker exec -it` loses its real terminal — the prompt emits raw `${…}` escape templates and the pty falls back to 80x24 in a corner of the window. Resolve first, exec second: `GH_TOKEN=$(op read "$ref")`, export it, then `exec docker exec -e GH_TOKEN`. The value still travels in the environment and never in argv. Everything else about 0.2.0 stands.


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
| Credential in the sandbox | none | one fine-grained PAT, in the env of `./shell.sh` shells only |
| Moving parts | systemd timer + `relay.mjs` + App private key on the host | two shell wrappers (`up.sh`, `shell.sh`) + an inline git credential helper |
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
- [ ] `.docker/sandbox.env` (gitignored) holds the secret **reference**, `.docker/sandbox.env.example` (committed) the key
- [ ] `./up.sh` is a plain `docker compose up -d` — **no credential, idempotent, safe to repeat**; `./shell.sh` does `op read` → `export GH_TOKEN` → `exec docker exec -e GH_TOKEN <container> "$@"` (never `op run` around the exec), and fails loudly when the container is down, the `op://` reference is missing, or `op read` returns nothing
- [ ] A shell opened with `./shell.sh` renders normally — full-width prompt, `stty size` matching your terminal, no raw `${…}` in the prompt
- [ ] The token is **not** in the compose config: `docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' <container> | grep -c '^GH_TOKEN'` is `0`, and a second `./up.sh` on a running container reports `Running` (same container id), never `Recreated`
- [ ] Fail closed: a shell opened *without* the wrapper (`docker exec -it <container> zsh`) has no token — `git push` gets `401`, `gh` says it is not logged in
- [ ] The container's startup command sets an **inline, env-reading** git credential helper and a distinguishable git identity — no token on disk
- [ ] `.claude/settings.json` no longer denies `Bash(git push:*)` (a broad deny beats every allow); it allows `git push origin claude/*` + `gh pr create/view/checks` and denies force pushes, pushes to `main`, remote branch deletion (**both** the `--delete` flag and the `git push origin :branch` refspec form — the flag alone leaves a hole), `gh pr merge`, `gh auth`, `gh api` (in the container's `bypassPermissions` default only the denies bite; the allows serve host / non-bypass sessions)
- [ ] Ruleset on `main`: PR + required check + `non_fast_forward` + `bypass_actors: []` (the `cloudflare-workers-builds-keyless-deploy` ruleset); optional second ruleset `~ALL` branches: `non_fast_forward`
- [ ] `CLAUDE.md` states the convention: work on `claude/<topic>`, push + `gh pr create`, never merge (or the opt-in rule below)
- [ ] E2E: in-container commit → `git push origin claude/e2e` → `gh pr create --fill` → `gh pr checks` shows CI; `gh pr merge` is refused by the deny rule; a push to `main` is refused by GitHub
- [ ] If migrating from the relay: timer disabled, App kept as the revert path, `Relay-Merge` convention removed from `CLAUDE.md`
- [ ] Every `UNVERIFIED:` bullet below checked on the real setup and written back

## Architecture in one screen

```
host  ./up.sh    =  docker compose up -d              ← no credential; idempotent, safe to repeat
      ./shell.sh =  GH_TOKEN=$(op read "op://<vault>/<item>/credential"); export GH_TOKEN
                     [ -t 0 ] && [ -t 1 ] && TT=-it || TT=-i
                     exec docker exec $TT -e GH_TOKEN <container> "$@"
           │        (1Password unlock. NOT `op run …`: it interposes on stdout/stderr and
           │         an interactive `docker exec -it` then loses its terminal — see pitfalls)
           │        -e GH_TOKEN is NAME-ONLY: value comes from this script's env, never argv (`ps`-safe)
           └─ no op session / op read fails / empty → shell.sh exits before exec: no token, no push
container  no token in Config.Env or PID 1; GH_TOKEN exists in ./shell.sh shells and their children only
           ├─ git   credential.helper = inline sh that echoes $GH_TOKEN   (nothing under ~/.git-credentials)
           ├─ gh    reads GH_TOKEN itself ("takes precedence over previously stored credentials")
           └─ Claude Code  allow: git push origin claude/*, gh pr create|view|checks   deny: --force, main, --delete, gh pr merge, gh auth, gh api
GitHub   fine-grained PAT → ONE repo · Contents + Pull requests · no Workflows · 90-day expiry
         rulesets: main = PR + required check + no force + bypass_actors: []   (optional: ~ALL = no force push)
```

| Layer | Owns | Must not do |
|---|---|---|
| 1Password item | the only copy of the token, its expiry | be read by anything but `op run` / `op read` on the host |
| `op read` + `docker exec -e` | token → one shell's env, once per `./shell.sh` | put the value in argv, in a file, or in the container's config; wrap the interactive exec in `op run` |
| git credential helper | answer `git push` from `$GH_TOKEN` | persist (`store` / `cache` helpers are out) |
| `gh` | API calls with `GH_TOKEN` | `gh auth login` (would write a token to `~/.config/gh/hosts.yml` on disk) |
| Claude Code rules | keep the *well-behaved* agent on `claude/*` and off merge | be mistaken for the security boundary |
| ruleset + token scope | the boundary: what a **compromised** sandbox can still do | — |

## Setup

Human steps once; copy-ready files in the references.

1. **Mint the token** on GitHub (scope above) and paste it straight into 1Password: `op item create --category "API Credential" --title "github-pat-<repo>-sandbox" --vault "<vault>" 'credential=<token>' 'expires=<YYYY-MM-DD>' …` — then close the GitHub tab; the token now exists in exactly one place. [references/token-and-1password-setup.md](references/token-and-1password-setup.md)
2. **`op` on the host**: install from 1Password's apt repo; enable *Settings → Security → Unlock using system authentication* and *Settings → Developer → Integrate with 1Password CLI* so `op read` / `op run` unlock with the desktop app instead of a master-password prompt (without the app: `eval $(op signin)` **in the terminal you run `./shell.sh` from**, 30-minute session).
3. **Env template + the two wrappers**: `.docker/sandbox.env` = `GH_TOKEN="op://<vault>/github-pat-<repo>-sandbox/credential"` (gitignored — it is a reference, but host-specific); `up.sh` = `exec docker compose up -d "$@"` (no `op`: starting the container has nothing to do with the token); `shell.sh` resolves the `op://` reference with `op read`, exports `GH_TOKEN`, then `exec docker exec -e GH_TOKEN <container> "$@"` — **not** `op run` around the exec (0.2.1: that breaks the terminal, see pitfalls) — guarded so it fails loudly when the container is down, the reference is missing, or `op read` returns nothing. Copy-ready in [references/compose-and-git-wiring.md](references/compose-and-git-wiring.md).
4. **Compose**: keep the committed `docker-compose.yml` **free of the token**, and say so in a comment so the next session doesn't "fix" it back. The inline credential helper + identity lines go in the `command` chain (mind compose's `$$` escaping); they read `$GH_TOKEN` at push time, so they are inert everywhere except a `./shell.sh` shell. Same reference — the env-in-compose alternative and its 3-valued startup check are there too.
5. **Claude Code rules**: replace `"Bash(git push:*)"` in `deny` with the targeted list; add the `git push origin claude/*` and `gh pr …` allows. Same reference.
6. **Rulesets**: `main` per the keyless-deploy skill; optionally `~ALL` no-force. [references/rulesets-and-policy.md](references/rulesets-and-policy.md)
7. **`CLAUDE.md`**: the branch / PR / no-merge convention; "a `401` means you are in a plain `docker exec` shell — the human opens a tokened one, don't work around it"; "the token is the project's, not yours — don't print it, don't `gh auth login`"; and "never run `docker compose up` from inside". Full paragraph in the wiring reference.
8. **E2E** (below), then record what differed under *Still open*.

## The fail-closed property (why `./shell.sh` is the only door)

The token is never a default and never cached: no file, no keychain, no `gh auth` state. A shell that did not come from `./shell.sh` can commit but **cannot push** — `git push` gets `401` / `remote: Invalid username or token`, `gh` says it is not logged in. `docker exec -e GH_TOKEN` is **name-only**, so it forwards the value from the calling process's environment (which `shell.sh` exported) and, when there is none, sets nothing at all: "the Docker CLI client checks the value the variable has in your local environment and passes it to the container", and with no `=` and nothing exported the variable stays unset in the container (`docker run` reference — the `docker exec` page doesn't spell this out, verified by experiment 2026-08-23). `shell.sh` refuses *before* exec'ing on all three failure shapes (container down, no `op://` reference in the env file, `op read` failing or returning empty), so the failure is a message rather than a silent tokenless shell.

### Correction to 0.1.x — compose does **not** drop a valueless key

The old text said compose removes an `environment` key it cannot resolve. Reproduced on Compose **v5.3.1** / Engine **29.6.2** (2026-08-23), it does not:

| `environment:` form | host var | `docker inspect … Config.Env` | inside the container |
|---|---|---|---|
| `GH_TOKEN:` | unset | **bare `GH_TOKEN`, no `=`** | unset (`env` prints no line for it) |
| `GH_TOKEN:` | set | `GH_TOKEN=<value>` | set |
| `GH_TOKEN: "${GH_TOKEN:-}"` | unset | `GH_TOKEN=` | **set but empty** |

Fail-closed still holds — in row 1 the container process sees nothing — but the *diagnosis* was wrong, and it cost a wrong turn on kokemusu: `docker compose config` prints `GH_TOKEN: null`, `docker inspect` shows what reads as the key being present, and the obvious check counts it as injected. **Check for the `=`:**

```sh
docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' <container> > /tmp/env.txt

grep -c '^GH_TOKEN=.' /tmp/env.txt        # a real value   → 1   ← the check you want
grep -c '^GH_TOKEN='  /tmp/env.txt        # value OR empty → 1   (row 3 counts too: not proof of a token)
cut -d= -f1 /tmp/env.txt | grep -cx GH_TOKEN   # ← DON'T: even row 1's bare key counts as 1
```

Three cases, so a two-way check can't cover them: `=.` separates "has a value" from both failures, plain `=` separates rows 2-3 from row 1, and `cut` separates nothing. In the env variant use the 3-valued startup check as the authority (see the wiring reference) and treat these greps as a spot check.

A **bare key means the value never reached the `docker compose` process** — an expired `op` session, the wrong `--env-file`, a `-f` that unloaded the override — not that compose is broken: row 2 shows the pass-through resolving fine once the value is actually there. The exec-time default sidesteps the table entirely: with no `GH_TOKEN` in the compose file, `grep -c '^GH_TOKEN'` is simply `0` and anything else is a finding.

## Merge policy (the one decision the relay made for you)

- **Default — human merges.** `deny: Bash(gh pr merge *)`; the agent ends its work at "PR open, CI green, here is the URL". Reviewing and merging on the host is the governance step, exactly as with the relay without the trailer.
- **Opt-in — agent-initiated merge.** Allow `Bash(gh pr merge --auto --squash *)` only; enable *Allow auto-merge* in the repo settings. `--auto` is the explicit, auditable signal (it shows in the PR timeline) and GitHub merges only once the ruleset's required checks pass — the same semantics the `Relay-Merge: yes` trailer had, minus the relay. Don't allow a bare `gh pr merge`, which merges immediately when checks already pass.
- Either way the agent **cannot approve** its own PR (same account), so `required_approving_review_count` stays `0` for a solo repo — a required review would make every PR unmergeable by anyone.
- Arming the opt-in needs two repo-side switches: *Allow auto-merge* in settings (`gh repo edit --enable-auto-merge`; public + Free plan is enough) and a ruleset with required checks on the base branch — GitHub offers auto-merge only on a PR that cannot merge immediately. **Without the ruleset, `gh pr merge --auto` never waits for CI** — it takes one of two paths, both wrong: if GitHub reports the PR as mergeable now (`mergeStateStatus` `CLEAN` / `UNSTABLE`), gh merges it **on the spot** with `autoMergeRequest` left `null` (matatabetai #13, okayus-skills #28, 2026-08-29); if mergeability is still being recomputed (`UNKNOWN`, e.g. seconds after another PR landed on `main`), gh sends the mutation and GitHub refuses with `GraphQL: Pull request Protected branch rules not configured for this branch (enablePullRequestAutoMerge)` (matatabetai #14, same day). So the ruleset is a hard prerequisite of the opt-in, not a nicety — write the allow into settings only after `gh ruleset check main` lists the required check. With the rulesets in place the same command **arms** instead: `autoMergeRequest.enabledAt` is set, the PR waits for `ci`, and GitHub squash-merges it seconds after the check passes (matatabetai #15, 2026-08-29, host OAuth `gh`). Pair the allow with a written exception list in `CLAUDE.md` (matatabetai: PRs touching `drizzle/`, `.github/**`, `.claude/**`, `docs/adr/**` wait for the human). The boundary argument for allowing it at all: `--auto` adds nothing a compromised sandbox couldn't already do — the merge API was always one `PUT` away (threat model below); what changes is only the *cooperative* agent's blast radius, insured by the required checks.

## The workflows gap — remove the need, not the guard

The deliberate `workflows` gap eventually bites: a CI fix lands in `.github/workflows/**` and only the human can push it (matatabetai #12 — a deploy.yml pinning an old pnpm version that conflicted with `packageManager`). The tempting fix is granting the fine-grained **Workflows** permission. Don't, while anything in Actions holds secrets: a `pull_request`-triggered run executes the **PR branch's** yaml with repo secrets available, *before any human review* — and the permission also lets the agent rewrite the job behind the very `ci` check the ruleset requires for its merges.

Instead make the workflow yaml a **stable shell** that stops needing edits (matatabetai #13):

- steps only call files the token *can* push: a root `package.json` script (`"ci": "pnpm -r run check && pnpm -r run build"`; the yaml step is just `pnpm run ci`), repo scripts (hooks), and the node pin via `node-version-file: .node-version` — an `engines` range like `>=24` would float to future majors, a version file pins it, and the agent can edit the file
- action `@vN` bumps arrive as Dependabot PRs (`package-ecosystem: github-actions`); `.github/dependabot.yml` sits **outside** `.github/workflows/`, so the token can push changes to it

After this, "change what CI does" is a package.json edit from inside the sandbox; the yaml changes only when the pipeline's *shape* does. Honest accounting: CI behavior was agent-editable all along (the yaml already ran repo-controlled `pnpm` scripts), so the stable shell adds convenience, not exposure — the boundary (no `workflows` permission) stays exactly where it was.

## Upgrading a repo already wired (0.2.x) — checklist

Repos wired before 0.2.4 run the human-merge default with the node version and every CI step written into the yaml. Moving one to opt-in merge + stable-shell CI is one repo setting and two host-side PRs; done on matatabetai (#13 / #14, 2026-08-24), then kokemusu (#16 / #17) and mazuoboeru (#93 / #94) on 2026-08-29.

0. **Verify the preconditions with the API, not from memory**: `gh ruleset check main` lists `pull_request` and `required_status_checks` (`ci`); `gh secret list` is empty (deploys are Workers Builds). If Actions still holds a secret, do the stable shell but keep human merge until it is gone — a `pull_request` run executes the PR branch's yaml with secrets available, before any review.
1. `gh repo edit <owner>/<repo> --enable-auto-merge` (idempotent; public + Free is enough).
2. **PR "stable shell"** (touches `.github/**` → a human pushes it): `.node-version` + `node-version-file`, a root `ci` script replacing the run steps (`pnpm run ci` is the only step left), `.github/dependabot.yml` for `github-actions`, and drop any `version:` under `pnpm/action-setup` (it duplicates `packageManager` and breaks the moment either moves). The PR's own CI validates it — `pull_request` runs the PR-side yaml.
3. **PR "opt-in"**: `.claude/settings.json` — delete `Bash(gh pr merge *)` from `deny`, add `Bash(gh pr merge --auto --squash *)` to `allow`; `CLAUDE.md` — the merge rule plus the exception list (migrations, `.github/**`, `.claude/**`, `docs/adr/**`, "anything you'd hesitate over"); then every doc that repeats the deny list (dev-environment, ADR addendum, status hub). An agent editing its own permission rules is exactly what an auto-mode classifier blocks — expect to make that one edit by hand or through a tool call the human approves.
4. **A live container session shares the checkout** (bind mount): switching branches in the repo directory pulls the working tree out from under it. Do host-side PRs in a `git worktree` (`git -C <repo> worktree add -b <branch> ../<repo>-wt origin/main`) and remove it afterwards.
5. **Merge what was waiting.** Before the switch, PRs sit until a human merges them — kokemusu #15 (a production 500 fix) waited five days with the sandbox agent polling `gh pr view` for the merge. Clear the queue when you flip the policy.
6. **First sandbox PR after the switch**: arm with `--auto --squash` right after `gh pr create`, while `ci` is still running — that is the path that exercises the `enablePullRequestAutoMerge` mutation with the fine-grained PAT (still UNVERIFIED below); an already-green PR merges immediately and proves nothing. Write the result under *Still open*.

## What a compromised sandbox can do now (be honest with yourself)

| Can | Cannot |
|---|---|
| push any commit to any **non-protected** branch of the one repo (incl. overwriting other `claude/*` branches unless the `~ALL` no-force ruleset exists) | push to `main` (ruleset, no bypass) — **except** the head of an open PR that already satisfies the rules, which GitHub treats as merging that PR (see pitfalls); force-push `main`; delete `main` |
| open / edit / close PRs and comments, as you | edit `.github/workflows/**` (no `workflows` permission — GitHub rejects the push) |
| merge a PR whose required checks pass (`contents: write` covers the merge API; the `gh pr merge` deny stops the well-behaved agent, not a malicious dependency) | touch any other repository, gists, packages, org settings |
| read the one repo (and every public repo) | outlive the expiry, or survive a revoke |

If the "merge a CI-green PR" row is unacceptable, that is the line where the relay (policy outside the boundary) is the right tool, not a stricter deny list. Mitigations that *do* work here: strong required checks (tests), reviewing PRs before merging, short expiry, revoke-on-suspicion.

Exec-time injection narrows *when*, not *what*: a malicious postinstall running under `npm install` in a plain `docker exec` shell — or in any container process that is not a child of `./shell.sh` — finds no token at all, whereas with the token in the compose `environment:` every process in the container has it for the container's whole life. Anything compromised **inside** a tokened shell still has the full table above. Treat this as reducing exposure surface, not as a boundary.

## Ops

- **Rotation** (every 90 days, or on suspicion): GitHub → the token → *Regenerate* → `op item edit "github-pat-<repo>-sandbox" 'credential=<new>' 'expires=<date>'` → **open a fresh `./shell.sh`**; that is all, the container is not involved. (In the env-in-compose variant there is no gentle path: the container's env is fixed at creation, so rotation means `./up.sh`, which recreates the container because the value changed — verified 2026-08-23, so `--force-recreate` is unnecessary — and kills whatever was running inside. One more reason the exec-time default is the default.) Delete the old token on GitHub if *Regenerate* didn't.
- **Expiry**: the first symptom is `git push` → `401` / `remote: Invalid username or token` in the container. Check `op item get … --fields label=expires` before debugging anything else.
- **Revoke on incident**: delete the token on GitHub (instant, global) — nothing inside can refresh it — then exit every `./shell.sh` shell (env-in-compose variant: `docker compose down`), and inspect the repo's recent pushes / PRs / merges with `gh api repos/<o>/<r>/events` from the host.
- **Host visibility**: with exec-time injection `docker inspect` shows **no** token; the value lives in the environment of the `docker exec` client process, which the same user can read via `/proc/<pid>/environ` — the host is trusted either way, and it is out of `ps` argv, which is the part other tooling scrapes. (Env-in-compose variant: `docker inspect` prints the value outright.) Nothing persists it: the only named volumes are `~/.claude` and the shell history, and nothing writes the token to either.
- **Never**: `gh auth login` in the container (writes the token to `~/.config/gh/hosts.yml` — container layer, so it survives `stop`/`start`/`restart` and only dies on `down`; a token on disk is exactly what this design avoids), `git config credential.helper store`, `echo $GH_TOKEN` in a transcript, the token on a `git push https://x-access-token:…@github.com/…` URL (ends up in `.git/config` / history).

Runbooks, the relay-migration checklist and the threat model in full: [references/rulesets-and-policy.md](references/rulesets-and-policy.md).

## E2E acceptance test

1. `./up.sh` → the container starts holding **no** token: `docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' <container> | grep -c '^GH_TOKEN'` → `0`. Run `./up.sh` again → `Running`, same container id — nothing recreated, nothing inside killed.
2. `./shell.sh` → in that shell `echo ${#GH_TOKEN}` prints a length (93 for a fine-grained PAT), `gh auth status 2>&1 | grep -c GH_TOKEN` is `1` (don't paste the full output — it prints the token's `github_pat_<id>_` prefix), `git config --global credential.helper` prints the inline helper with a single `$GH_TOKEN`, and nothing exists at `~/.git-credentials` / `~/.config/gh/hosts.yml`. On the host, `ps -eo args | grep '[d]ocker exec'` shows `-e GH_TOKEN` with **no value after it** (the `[d]` keeps grep from matching its own command line). The prompt must render normally — full width, `stty size` matching your terminal, no raw `${…}` templates (0.2.0's `op run` wrapper failed exactly here). Drive one-liners with `./shell.sh zsh -lc '…'`, which needs the TTY-detecting `-it`/`-i` line from the pitfalls; note `sh -lc` lacks the npm-global bin on PATH, so `claude` isn't found there.
3. In that shell: `git switch -c claude/e2e-token`, a doc tweak, commit (author shows the sandbox identity), `git push -u origin claude/e2e-token` → accepted; `gh pr create --fill` → PR URL; `gh pr checks --watch` → CI result.
4. Negative checks: an empty commit on a throwaway branch **with no PR**, then `git push origin HEAD:main` → `GH013 … Changes must be made through a pull request` (pushing the head of an open CI-green PR would instead *merge* it — see pitfalls); a commit touching `.github/workflows/ci.yml` → `! [remote rejected] … refusing to allow a Personal Access Token to create or update workflow … without \`workflow\` scope`; the deny rules under the container's bypass mode via `claude -p "run gh pr merge <n> --help, gh auth status, gh api …"` → each `Permission to use Bash with command … has been denied`, while `gh pr view` runs.
5. Fail-closed: open a shell **without** the wrapper — `docker exec -it <container> zsh` → `echo ${GH_TOKEN-unset}` says `unset`, `gh auth status` says not logged in, a push fails with `Invalid username or token`. The same push from `./shell.sh` succeeds. Restoring the token is a **human** step by design: `op` has no session in an agent's non-interactive shell, so an agent cannot re-open its own tokened shell.
6. On the host: merge the PR, confirm `delete_branch_on_merge` removed the remote branch; in-container `git fetch --prune`.

## The pitfalls that eat hours

- **`Bash(git push:*)` left in `deny`** → every push blocked no matter what you allow ("a deny rule can't carry allowlist exceptions"). Replace it with the targeted denies.
- **`git push -u origin claude/x` doesn't match `Bash(git push origin claude/*)`** → the flag sits before `origin`; add the `-u` form (and expect prompts for other flag orders — argument-constraining patterns are documented as fragile; the ruleset is the guard). Note the scope of the allow list: "Allow rules have no effect in `bypassPermissions`" (permission-modes docs), which is the container's default — inside, only the **deny** list acts; the allows matter for host / non-bypass sessions on the same repo.
- **Putting the token in compose `environment:` costs you the container — and the session inside it.** `GH_TOKEN: "${GH_TOKEN:-}"` makes the token part of the container's *configuration*, and "if there are existing containers for a service, and the service's configuration or image was changed after the container's creation, `docker compose up` picks up the changes by **stopping and recreating** the containers" (compose `up` reference, 2026-08-23). So one plain `docker compose up -d` — a habit, another skill's instructions, a second terminal — recreates the container: new container id, token gone, every process inside killed, including the agent session you were in the middle of. Reproduced 2026-08-23 (13-char value → `Recreated` → `len=0`). This is what moved the injection point: with nothing secret in the config, repeated `docker compose up -d` reports `Running` and touches nothing (verified the same day). If you keep the env variant anyway, treat `docker compose up` as the destructive one — `docker compose exec` is fine ("the equivalent of `docker exec` targeting a Compose service"), it is `up` that reconciles.
- **`docker exec` inherits the environment of container *creation* and never reconciles it** ("The `docker exec` command inherits the environment variables that are set at the time the container is created"). Two consequences. It is why an exec-time token stays invisible to the rest of the container — the `-e` value is set on that one exec, not on the container. And in the env variant it means **re-exec'ing does not pick up a rotated token**: the container's creation-time env is fixed, so rotation there requires recreating the container, which kills everything inside. Only the exec-time default lets a new token arrive without disturbing anything — the next `./shell.sh` carries it.
- **`op run` around an interactive `docker exec -it` destroys the terminal.** Symptom on kokemusu (2026-08-23): the powerlevel10k prompt printed as raw `${_p9k__…}` templates and the pty fell back to **80x24**, painting into a corner of the window; window resizes (`SIGWINCH`) never reached the shell. The docs do **not** describe this — they only say "Secrets printed to stdout or stderr are concealed by default" (`op run` reference, 2026-08-23), with nothing about TTYs or pty allocation. The terminal breakage is the observation; concealing output the child writes means `op run` must sit on those streams, and that is the inference. Treat the mechanism as inferred and the symptom as measured. **Fix**: resolve first, exec second — `GH_TOKEN=$(op read "$ref")`, `export GH_TOKEN`, `exec docker exec $TT -e GH_TOKEN …`. `op read` writes the secret to *its own* stdout, which you capture, and nothing interposes on the shell you actually get. `op run --no-masking` turns the concealing off but is **not** the fix to reach for: whether it also stops the stream interposition is undocumented and unverified, and it removes the safety net for the non-interactive uses where `op run` is still fine.
- **`./shell.sh zsh -lc '…'` from a script fails with `cannot attach stdin to a TTY-enabled container because stdin is not a terminal`** — `-it` demands a terminal that a non-interactive caller doesn't have (verified 2026-08-23). Pick the flag from the caller: `[ -t 0 ] && TT=-it || TT=-i` and `exec docker exec $TT -e GH_TOKEN …`. Without that, the E2E's "drive one-liners from the host" step only works when you type it yourself.
- **`op run … -- env` prints `<concealed by 1Password>` — exactly 24 characters.**
 1Password masks output matching a secret it injected, so a length check routed through `env` reads 24 for a 93-character PAT and looks like a truncated or broken token. It is the mask, not the value. Measure with output that can't match the secret: `op run --env-file=.docker/sandbox.env -- sh -c 'echo ${#GH_TOKEN}'`.
- **`gh pr edit` dies on a Projects-classic GraphQL error** — `Projects (classic) is being deprecated in favor of the new Projects experience … (repository.pullRequest.projectCards)` — because that `gh` queries the deprecated `projectCards` field even with no project flag. This is **an old-`gh` problem**: cli/cli [#11983](https://github.com/cli/cli/issues/11983) was closed as completed on 2025-10-21 and current `gh` is v2.98.0 (2026-08-20), but the sandbox image is years behind — Anthropic's devcontainer base is Debian bookworm, whose `apt install gh` gives **`2.23.0+dfsg1-1`** (upstream 2.23.0, 2023-02). Options, in order: install `gh` from GitHub's own apt repo in the Dockerfile (build-time network is open — see `claude-code-docker-sandbox`), or, without a rebuild, post the update as a PR *comment* (`gh pr comment`, present even in 2.23.0 — add it to the allow list) or edit the body from the host. Upstream's own workaround, `gh api -X PATCH repos/<o>/<r>/pulls/<n> -f body=…`, is **denied by this skill** (kokemusu, 2026-08-23).
- **`$GH_TOKEN` written as `$GH_TOKEN` in `docker-compose.yml`** → compose interpolates it at parse time (empty). Write `$$GH_TOKEN` so the container's shell sees `$GH_TOKEN`.
- **`git push origin HEAD:main` *succeeded* in the E2E** → that commit was the head of an open PR whose checks had just passed, and GitHub treats such a push as merging that PR (fast-forward; the PR flips to *merged*). The `pull_request` rule was satisfied, not bypassed. Consequences: test the guard with a commit that has **no** PR, and deny the refspec forms too (`git push *main`, `git push *main *`) — `gh pr merge` is not the only merge path.
- **Reading CI with `gh api …/check-runs`** → `gh api` is denied by the template (the merge endpoint is one `PUT` away), and even where allowed, fine-grained PATs can't call the Checks REST API. Read CI with `gh pr checks` (GraphQL), or the relay's unauthenticated `curl` on a public repo.
- **A bare `GH_TOKEN` (no `=`) in `docker inspect`'s `Config.Env`** → the value never reached the `docker compose` process. Don't read it as "compose is broken" or as "the key is there": it is exactly what *unset* looks like in the valueless form (see the table above). Compose prints no warning either way.
- **Two projects, one 1Password item title** → a copy-pasted `op item create … --title github-pat-<other-repo>-sandbox` silently creates a *second* item with the other project's name; `op read` then fails (`could not find item …`) for the new project and becomes ambiguous for the old one — the wrong repo's token can end up in a container. One title per repository, and `op item list --vault <vault> | grep github-pat-` before the first `./shell.sh` (kokemusu, 2026-08-22).
- **`gh pr create` → `No commits between main and <branch>`** → the E2E branch needs at least one commit beyond `main` (`git commit --allow-empty` is enough).
- **`claude -p` in the container fails with `OAuth session expired and could not be refreshed`** → the `claude-config` named volume kept a login from weeks ago; re-login interactively once (`docker exec -it <container> claude` — never `docker compose up`), then the deny probes run. Unrelated to the token.
- **Pushes start failing with 401 one morning** → the token expired; 1Password `expires` first, GitHub second.
- **`gh auth setup-git` inside the container** → adds gh as a credential helper too; harmless with `GH_TOKEN`, but it's one more path — keep the inline helper as the only one.
- **Token in a remote URL** → `git remote set-url` with `https://x-access-token:<token>@…` lands in `.git/config`, which the host shares and `git remote -v` prints. Never.
- **Leftover local `claude/*` branches** → no relay reaps them; `git fetch --prune` after merges, and `delete_branch_on_merge=true` on the repo.
- **Assuming the `~ALL` no-force ruleset blocks squash merges** → it doesn't (a merge is a fast-forward of `main`); it only blocks rewriting pushed branches.
- **Private repo on a Free plan = no server-side boundary at all.** Rulesets and branch
  protection are not enforced on private repos without Pro/Team, so the `main` guard this
  skill relies on (PR + required check + `bypass_actors: []`) silently does nothing: a
  tokenless mistake or a compromised sandbox can push `main` directly, and the E2E's
  `GH013` negative test will *pass the push instead of rejecting it*. Make the repo public
  (every okayus project does) or pay for Pro before wiring the token; until then only the
  Claude Code denies and a pre-commit hook stand between the sandbox and `main`
  (matatabetai, 2026-08-23).
- **Going public is only half the fix — the rulesets don't create themselves.** matatabetai
  went public on 2026-08-23 *because of* the pitfall above, and a 2026-08-24 audit still found
  `gh ruleset list` empty and `gh ruleset check main` reporting `0 rules apply`: the repo was
  public with `main` guarded by nothing but the Claude Code denies and a pre-commit hook —
  while the project's own docs (status hub, CLAUDE.md, roadmap) still said "private, ruleset
  pending"; only the ADR recorded the flip. Two lessons: verify the boundary with the API
  (`gh ruleset check main` must list the protect-main rules), never with memory or project
  docs; and treat "flip visibility" + "create rulesets" as ONE step — the first without the
  second changes nothing about the boundary, silently (matatabetai, 2026-08-24).

## Verified on mazuoboeru (2026-08-22, first application)

Confirmed on the real setup (okayus/mazuoboeru, PR #88):

- The inline credential helper survives compose's quoting: `git config --global credential.helper` inside the container prints a single `$GH_TOKEN`. `docker compose config` shows `$$GH_TOKEN` — that is the output re-escaping `$`, not a bug.
- A valueless `GH_TOKEN:` produces **no compose warning** when unset and the container process sees no token. "Dropped" was the wrong word for it, though — see 0.2.0's correction table: `Config.Env` keeps a bare `GH_TOKEN` with no `=`. What was actually verified here is the observable: no warning, and the startup `NOTE` echo plus `gh auth status` are the only signals.
- `gh pr create`, `gh pr view`, `gh pr checks` all work with a fine-grained PAT holding Contents + Pull requests (+ Metadata); the PR author is the token owner.
- Workflow-file push rejection, verbatim: `! [remote rejected] claude/e2e-token -> claude/e2e-token (refusing to allow a Personal Access Token to create or update workflow \`.github/workflows/ci.yml\` without \`workflow\` scope)` — the same wording as for classic PATs.
- Deny rules act under the container's `bypassPermissions` default: `gh pr merge <n> --help`, `gh auth status`, `gh api …` → `Permission to use Bash with command … has been denied`; `gh pr view` runs. Probed with `claude -p` from the host via `docker compose exec -T dev zsh -lc`.
- The `API Credential` item's field is `credential` — `op://<vault>/<item>/credential` resolved.
- A commit with no PR pushed to `main` → `GH013 … Changes must be made through a pull request. … Required status check "ci" is expected.` The head of an open, CI-green PR pushed to `main` **succeeds and merges that PR** (pitfalls) — the E2E's negative test must use a PR-less commit.
- `gh auth status` prints the `github_pat_<id>_` prefix of the token (the id part, not the secret) — keep it out of transcripts anyway.
- The passthrough key can live in the committed `docker-compose.yml` instead of the override (mazuoboeru does): it is not a secret and is inert when unset; only `.docker/sandbox.env` is host-specific.
- Without the desktop-app integration, `eval $(op signin)` in the same terminal (30-minute session) followed by `./up.sh` was the working loop on Linux (0.2.0: the `op signin` now has to be in the terminal you run `./shell.sh` from); the integration itself has not been tried (both applications unlocked this way).
- `Bash(git push *main)` blocks the refspec form: under bypass mode `claude -p` reported `git push origin HEAD:main` → `Permission … has been denied` (kokemusu, 2026-08-22); `HEAD:refs/heads/main` ends in `main` too and matches the same rule.
- Second application, kokemusu (2026-08-22, a fresh public repo wired from the skill in one pass): identical results for push / PR / checks, the PR-less `main` push, the workflow rejection and the egress split; see pitfalls for the item-title collision and the `No commits between` and OAuth-expiry surprises.
- Fifth data point, matatabetai (2026-08-29): the two rulesets were created (`protect-main` + `no-force-push-anywhere`; `gh ruleset check main` → 5 rules) and GitHub added `require_extra_approval_for_unattributed_changes: true` to the `pull_request` rule **by default** — it was absent from the posted JSON. That looked like a deadlock in waiting: the sandbox identity (`Claude (<repo> sandbox) <claude-<repo>-sandbox@users.noreply.github.com>`) is *unattributed* (`gh pr view --json commits` shows `authors[].login` empty), and nobody can approve the token owner's own PR. Tested instead of assumed: a PR whose only commit carried that identity armed with `--auto --squash` and auto-merged with 0 approvals (#15) — the default did not bite this solo flow. The keyless skill's ruleset JSON now sets it to `false` explicitly so the question doesn't come back.
- Fourth data point, matatabetai (2026-08-24): the public flip had happened the day before, but the rulesets were never created — caught only by an audit (see the new pitfall). The opt-in merge policy was adopted: the human removed the `gh pr merge` deny by hand (an agent editing its own permission rules is exactly what an auto-mode classifier should and did block), `--auto --squash` went into the allow list, exceptions into `CLAUDE.md`; the workflows gap was closed by need-removal instead of permission (*The workflows gap* above).
- Third application, matatabetai (2026-08-23, a **private** repo): wiring applied in one pass; the tokenless fail-closed start verified (the 0.1.0 startup echo, then worded `NOTE: GH_TOKEN absent`, in the log; helper present with a single `$GH_TOKEN`; `gh` not logged in — the current templates print `NOTE: no GitHub token in the container env by design …` / `NOTE: GH_TOKEN is unset …`). The token E2E waits for the PAT — and for the repo to go public, because the `main` ruleset is unenforced on a private Free-plan repo (pitfalls).

## Verified on kokemusu (2026-08-23) — the day that moved the injection point

The same second application (okayus/kokemusu, public repo) one day on — wiring it took a pass, *running* it turned up the rest. Everything in the mazuoboeru list reproduced. These are the new facts; the compose ones were re-confirmed in isolation on the same host with a scratch project on **Docker Compose v5.3.1 / Engine 29.6.2** — not re-checked on v5.5.x, whose release notes touch image-digest reconciliation and `--hash` service-environment resolution, though the `up` reference still documents recreate-on-config-change.

| Earlier claim (version) | Verdict | How it was checked |
|---|---|---|
| **0.1.x** — compose drops a valueless `environment` key it can't resolve | **false** | `Config.Env` keeps a bare `GH_TOKEN` with no `=`; `docker compose config` prints `GH_TOKEN: null` |
| …but the container is still tokenless | true | `env` inside prints no `GH_TOKEN` line — fail-closed survives the correction |
| **0.1.x** — `cut -d= -f1 \| grep -c` tells you whether the token arrived | **false** | counts the bare key as present; `grep -c '^GH_TOKEN=.'` is the check that works |
| `GH_TOKEN: "${GH_TOKEN:-}"` injects reliably | true | `Config.Env` gets `GH_TOKEN=<value>` |
| …and is therefore the fix | **false** | the token joins the container config → plain `docker compose up -d` = `Recreated`, new container id, `len=0`, every process inside killed |
| Exec-time injection keeps `up -d` idempotent | true | `up -d` twice → `Running`, same container id both times |
| `docker exec -e GH_TOKEN` (name-only) forwards the caller's value | true | set → forwarded; unset → unset inside; value absent from `ps -eo args` |
| A changed value makes `up -d` recreate (0.1.2's open item) | true | old → new → `Recreated` with the new value inside; `--force-recreate` not needed |
| **0.1.x** — `op run -- env` shows the token's real length | **false** | masked to `<concealed by 1Password>` = exactly 24 chars, for a 93-char PAT |
| `gh pr edit` works from the sandbox | **false** | Projects-classic GraphQL error on the image's gh 2.23.0; `gh pr comment` used instead |
| **0.2.0** — `op run -- docker exec -it` gives a usable interactive shell | **false** | `op run` interposes on stdout/stderr to conceal secrets → raw `${…}` prompt, pty stuck at 80x24. Fixed in 0.2.1 with `op read` |
| **0.2.0** — `./shell.sh zsh -lc '…'` works from a script | **false** with `-it` hard-coded | `cannot attach stdin to a TTY-enabled container`; `docker exec -i` (no `-t`) works |


- **The valueless pass-through can silently fail to resolve.** Started through `./up.sh` (0.1.x = `op run -- docker compose up -d`), the container had no token while `docker inspect` showed a **bare `GH_TOKEN`** (no `=`) in `Config.Env`. The obvious check (`cut -d= -f1 | grep -c`) counted that as present, so the debugging started at 1Password — the wasted hour that produced the `grep '^GH_TOKEN=.'` E2E step. In the clean repro the valueless form resolves fine whenever the value really is in the compose process's environment, so a bare key is the signature of **"the value never got there"**, not of a compose bug. What consumed it between `op run` and `docker compose` that day was never pinned down; the `=` grep would have said so in seconds.
- **`GH_TOKEN: "${GH_TOKEN:-}"` fixed the injection and broke something worse.** With the token in the config, a plain `docker compose up -d` recreated the container and killed the running Claude session. Isolated repro: a 13-character value → plain `up -d` with the host var unset → `Recreated`, new container id, `len=0` inside.
- **Exec-time injection is idempotent.** With no secret in the compose file, `docker compose up -d` twice in a row reports `Running` with the same container id — nothing to reconcile, nothing killed. This is the whole reason 0.2.0 changed the default.
- **`docker exec -e GH_TOKEN` (name-only) forwards the caller's value, and forwards nothing when it is unset** — verified both ways. The value never enters the `docker exec` argv (`ps -eo args` shows `docker exec -e GH_TOKEN <container> …`), unlike the `-e GH_TOKEN=$GH_TOKEN` form. It is still in that host process's environment, which the same user can read — the host is trusted either way.
- **Rotation recreates** — this closes 0.1.2's open item: old value → new value → plain `docker compose up -d` → `Recreated`, new value inside. `--force-recreate` is unnecessary. In the exec-time default rotation needs nothing at all: the next `./shell.sh` resolves the new value.
- **`op run … -- env` masks to `<concealed by 1Password>`, exactly 24 characters** — read as a truncated token before the mask was recognised.
- **The 3-valued startup check earns its keep in the env variant.** `present (len=N)` / `is empty` / `is unset` map exactly onto rows 2, 3 and 1 of the correction table, and only the 3-value form separates "compose resolved an empty string" from "the key never arrived".
- **`gh` from Debian bookworm apt is 2.23.0 (2023-02-27)** in the devcontainer base, and `gh pr edit` fails on the Projects-classic GraphQL field — the PR body update went in as a comment instead (pitfalls).
- The item-title collision, `gh pr create` → `No commits between …`, and the `claude -p` OAuth expiry were all first hit here; they live in the pitfalls list.

**0.2.1, the same evening — the first `shell.sh` was unusable interactively.** 0.2.0 shipped `op run --env-file=… -- docker exec -it …`, and every interactive shell it opened was broken: powerlevel10k printed raw `${_p9k__…}` templates and the pty sat at 80x24 in a corner of the window. `op run` conceals secrets on its child's stdout/stderr, so it interposes on those streams and the exec'd shell never gets the real terminal. What that does and does not change:

| | |
|---|---|
| **Changed** | how `shell.sh` reaches 1Password: `GH_TOKEN=$(op read "$ref")` + `export` + `exec docker exec -e GH_TOKEN`, instead of `op run -- docker exec`. The `op://` reference is parsed out of `.docker/sandbox.env` (strip quotes *and* trailing whitespace / CR, or `op read` fails on a file saved by a Windows editor — verified) |
| **Changed** | the failure shapes `shell.sh` guards: container down / no `op://` reference in the env file / `op read` failed or returned empty |
| **Unchanged** | exec-time injection itself — the 0.2.0 decision was right, only its wiring was wrong |
| **Unchanged** | the token stays out of the container config, so `./up.sh` is still credential-free and idempotent, and the recreate hazard is still what motivates all of this |
| **Unchanged** | name-only `-e GH_TOKEN`: the value comes from the environment, never argv, so it is still absent from `ps` |
| **Unchanged** | fail closed, rotation-by-new-shell, the compose correction table, the credential helper in `command:`, the rulesets and merge policy |

Also surfaced by the fix: `-it` hard-coded means `./shell.sh zsh -lc '…'` from a **non-interactive** caller dies with `cannot attach stdin to a TTY-enabled container because stdin is not a terminal` (verified 2026-08-23; `docker exec -i` without `-t` works there). The skill's own "drive one-liners from the host" step needs the `[ -t 0 ]` branch.


## Still open — confirm and write back

- UNVERIFIED: `gh pr merge --auto --squash` with a fine-grained PAT *when the ruleset makes the PR wait* — arming goes through the GraphQL `enablePullRequestAutoMerge` mutation; gh's GraphQL works with these tokens for `gh pr checks`, but the mutation itself is unexercised (the 2026-08-29 runs used the host's OAuth `gh`: #13 / #14 / #28 hit the immediate-merge path, and #15 — after the rulesets — exercised the mutation successfully; the PAT has not). matatabetai's first armed PR from the sandbox will say; write the result here.
- UNVERIFIED: the in-container service-account variant — the 1Password domains the egress firewall needs and the per-push request budget (the support page listing domains returned 403 to the fetch on 2026-08-22). See [references/service-account-variant.md](references/service-account-variant.md).
- UNVERIFIED: whether an agent working inside a `./shell.sh` shell ever loses the token mid-session (it shouldn't — the variable is in its own process env), and what the recovery is when the human is away: the agent cannot re-open a tokened shell by itself, by design.

## Scope boundary — what this skill does NOT cover

- The credential-free design (policy outside the boundary, GitHub App, `Relay-Merge`) — `sandboxed-agent-git-relay`
- The container, firewall, named volumes, `bypassPermissions` default — `claude-code-docker-sandbox`. **Applying this skill changes that skill's entry point**: its `docker compose exec dev zsh` still works but is deliberately tokenless now, so make `./shell.sh` the documented way in and keep the plain form for when you *want* no token
- The committed permission allowlist and the docs MCP — `cloudflare-mcp-claude-tooling` (this skill only changes the git / gh entries)
- The `main` ruleset JSON — `cloudflare-workers-builds-keyless-deploy` `references/ruleset.md`
- Application-level PATs issued by your own app to CLIs / agents — `cloudflare-workers-pat-bearer-auth` (different token, different threat model)
- Cloudflare credentials in the sandbox — none by design (Workers Builds keyless deploy); don't extend this pattern to them without the same "one resource, short expiry" discipline
- Multi-repo sandboxes, org PAT policies, GitHub Enterprise

## References

- [references/token-and-1password-setup.md](references/token-and-1password-setup.md) — fine-grained PAT click-path and permission table, `op` install + app integration, `op item create`, env template
- [references/compose-and-git-wiring.md](references/compose-and-git-wiring.md) — **copy-ready `up.sh` + `shell.sh`** (the exec-time default, with the `op read` / TTY-detection details that 0.2.1 fixed), the startup-command lines (credential helper + identity, `$$` escaping), the baked-script alternative, the env-in-compose variant with its 3-valued startup check and when to pick it, `.claude/settings.json` allow/deny, `CLAUDE.md` paragraph, in-container verification
- [references/rulesets-and-policy.md](references/rulesets-and-policy.md) — `main` + `~ALL` rulesets, merge policy options, threat model, rotation / expiry / revoke runbooks, migrating off the relay
- [references/service-account-variant.md](references/service-account-variant.md) — `op` inside the container with a vault-scoped service account: when it's worth it, setup, trade-offs
