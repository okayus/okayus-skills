---
name: sandboxed-agent-git-relay
description: Let a sandboxed coding agent (Claude Code in a Docker devcontainer with a bind-mounted repo) get its work onto GitHub as branches + PRs — and optionally all the way to MERGE — WITHOUT any credential ever entering the sandbox. A host-side systemd timer detects commits on claude/* branches, mints a 1-hour GitHub App installation token, pushes an exact refspec, opens the PR, and (only when the HEAD commit carries a Relay-Merge trailer) squash-merges it once the ruleset's required checks pass. Policy (branch prefix only, no force, never main, merge-by-explicit-signal) is enforced OUTSIDE the boundary. Use when an autonomous agent loop needs push/PR/merge but the rule is "no plaintext credentials in the sandbox". Covers why GitHub App beats deploy keys and GITHUB_TOKEN (PR CI approval gate), the App ID vs Installation ID confusion, the gh credential-helper hijack, the systemd AccuracySec=1min surprise, the squash-merge re-merge loop (three-dot diff can't detect a squash, so the relay re-merges every tick and mints empty commits — guard on a merged PR's head.sha), and reading PR/CI status from the sandbox with unauthenticated curl (gh refuses to run tokenless).
license: MIT
compatibility: Designed for Claude Code and similar agents. Host = Linux with systemd user units, node >= 20, git, gh CLI. Sandbox = Docker container with the repo bind-mounted (host and container share one worktree/.git). Repo on GitHub.
metadata:
  author: okayus
  version: "0.2.0"
---

# Sandboxed-Agent Git Relay (host-side push/PR with a GitHub App)

The agent in the sandbox can `git commit` (commits need no secret). Everything that
needs a credential — push and PR creation — is done by a tiny relay on the **host**,
reading the same `.git` through the bind mount. The sandbox never holds a token,
a key, or even a forwarded socket; it cannot push at all.

```
[sandbox: Claude]  commit on claude/<topic>           (bind-mounted worktree)
        │ (filesystem — no network, no creds; merge signal = "Relay-Merge: yes"
        │  trailer in the HEAD commit message, also just a commit)
[host: systemd timer, 60s] relay.mjs:
        scan refs/heads/claude/* → diff vs origin/main? → mint 1h App token
        → push exact refspec → ensure PR (idempotent)
        → if HEAD has the Relay-Merge trailer: squash-merge once checks pass
        REFUSE: non-claude/* refs, force push (diverged), main
[GitHub] ruleset on main (PR + required check, bypass_actors: []) = server-side backstop
         (also the merge gate: an early merge attempt gets 405 → retried next tick)
```

This is the pattern Anthropic documents for agent deployments ("a proxy outside the
agent's security boundary injects credentials; the agent never sees them") — applied
to git with zero in-sandbox moving parts.

## When to use this skill

- Autonomous agent working in an egress-restricted devcontainer must produce PRs unattended
- The project rule is "no plaintext credentials inside the sandbox" (cf. ADR-style secrets strategy)
- NOT when a human pushes anyway (just keep push on the host), and NOT for fork-based workflows

## Why a GitHub App (and not the alternatives) — verified 2026-06

| Option | Verdict |
|---|---|
| **GitHub App installation token** | ✅ 1-hour expiry, mintable offline from the App private key, down-scopable per token (one repo, `contents:write` + `pull_requests:write`), pushes/PRs trigger CI normally, PRs show a `bot` author |
| Deploy key (SSH) | repo-wide write **forever**, cannot create PRs (no API), needs ruleset care; SSH-agent forwarding grants ambient *use* to the sandbox — capability inside the boundary |
| `GITHUB_TOKEN` in Actions | PRs it creates get CI runs stuck in an **approval-required** state ("Approve workflows to run") — kills unattended loops |
| Fine-grained PAT | static user-bound bearer secret; expiry policy = recurring human toil |
| OIDC for git push | does not exist — GitHub's OIDC is outbound (Actions → clouds) only |

## Setup

1. **Create the App** (human, browser): github.com/settings/apps/new → name like `<project>-relay`; Homepage URL = the repo; **uncheck Webhook Active**; Repository permissions: `Contents: Read and write`, `Pull requests: Read and write`; "Only on this account". Then **Generate a private key** (.pem downloads) and **Install App** → only the target repo.
2. **Store the key on the host, outside every container mount**: `~/.config/<project>-relay/app.pem`, dir 700 / file 600. Sanity: `openssl rsa -in app.pem -check -noout`.
3. **Record IDs** in `config.env` next to the key — see [references/github-app-setup.md](references/github-app-setup.md) for the config template, the JWT smoke test, and the **App ID vs Installation ID trap** (the number in the install URL is the *installation* id; the App ID is on the App settings page; `GET /apps/<slug>` 404s for private apps, and `/user/installations` needs an App user token — so verify by minting a JWT and calling `GET /app` + `GET /app/installations`).
4. **Install the relay**: [references/relay-mjs.md](references/relay-mjs.md) → `~/.config/<project>-relay/relay.mjs`. ⚠️ Keep it **outside the repo** — the repo is writable from the sandbox, so in-repo policy code could be edited by the thing it polices.
5. **systemd user units**: [references/systemd-units.md](references/systemd-units.md) (60s timer; **set `AccuracySec=10s`** or the default 1-minute coalescing turns your 60s timer into ~2min ticks). Validate manually first: `set -a; . config.env; set +a; node relay.mjs` → expect an idle log line.
6. **Server-side backstop** (defense in depth, also the merge gate): ruleset on main with `bypass_actors: []` and `delete_branch_on_merge=true` — see the `cloudflare-workers-builds-keyless-deploy` skill's `references/ruleset.md` (works standalone).
7. **Sandbox side**: allow `git add/commit/checkout/switch` in `.claude/settings.json`, keep `Bash(git push:*)` in `deny` (deny rules hold even in `bypassPermissions` mode); set a distinguishable git identity in the container (`git config --global user.name "Claude (<project> sandbox)"`); convention: all agent work on `claude/<topic>` branches.
8. **Sandbox reads PR/CI status with unauthenticated curl, not `gh`**: `gh` refuses to run without a token even against public repos, and putting `GH_TOKEN` in the sandbox would break the whole premise. For a public repo, unauthenticated REST is enough (60 req/h/IP): `curl -s https://api.github.com/repos/<owner>/<repo>/commits/<branch>/check-runs` for CI results, `.../pulls?head=<owner>:<branch>` for PR state. Add the matching `Bash(curl -s https://api.github.com/*)` allow entry; the egress firewall already covers GitHub's IP ranges.

## Relay policy decisions (encoded in relay.mjs)

- **Prefix-only**: scans `refs/heads/claude/` and pushes `refs/heads/X:refs/heads/X` exact refspecs. main is structurally unreachable.
- **No force, ever**: if the remote branch is not an ancestor of the local tip, log `REFUSE` and skip — divergence is for a human to resolve.
- **Skip when no diff vs `origin/main`** (three-dot diff): empty new branches produce no PR. ⚠️ This three-dot diff does **NOT** detect a squash merge — filtering squash residue is `isTipAlreadyMerged`'s job (see "The squash-merge re-merge loop" below), not this check's.
- **Token hygiene**: minted per tick only when needed, down-scoped (`repositories: [repo]`, contents+PR write), passed to git via env + an inline credential helper — never argv, never disk. **Prepend `-c credential.helper=`** (empty) first: without that reset, a globally configured `gh` credential helper silently wins and pushes as the *user*, not the App.
- **Idempotent PR**: `GET /pulls?head=owner:branch` before `POST`; reruns log "PR exists".
- **Merge only on explicit signal**: see next section. No trailer → the relay never merges; the human does.

## Optional: agent-initiated merge (the `Relay-Merge: yes` trailer)

By default the human merges every PR. To let the agent close the loop unattended
(merge → deploy → verify), the relay also implements **merge delegation** — same
philosophy as push: *the signal comes from inside the boundary (a commit), the
execution and the policy live outside it.*

- **Signal**: the agent puts `Relay-Merge: yes` as a trailer in the **HEAD** commit
  message of the `claude/*` branch. A trailer on an older commit is void — pushing
  more commits requires re-signaling. This makes merge a deliberate, auditable,
  per-PR decision recorded in history (the trailer survives in the squash commit).
- **Execution**: the relay squash-merges the open PR, passing the local tip `sha`
  so GitHub rejects (409) if the branch moved in between (TOCTOU guard), then
  deletes the remote and local branch.
- **Safety**: CI-green is enforced **server-side** by the main ruleset — the relay
  doesn't need to (and doesn't) check CI itself. Signaling before CI finishes is
  safe: GitHub answers 405 ("Required status check ... is expected"), logged as
  `merge pending`, retried next tick. No extra App permission is needed
  (`contents:write` covers the merge endpoint).
- **What you give up, knowingly**: trailer'd PRs reach main (and any main-triggered
  deploy) with **no human review**. Mitigations: (a) the agent's own convention —
  *don't add the trailer for risky or uncertain changes*; (b) grow the ruleset's
  required checks (tests!) as the project matures. Record the governance change in
  an ADR; the revert path is "delete `tryMerge`" — ruleset, App, and sandbox config
  are untouched.

### The squash-merge re-merge loop (the one that bites — fix is mandatory)

`squash` merge does **not** make the branch's commits ancestors of `main`; only
their *content* lands, as one brand-new commit. So the three-dot diff
`origin/main...branch` **stays non-empty after a squash merge**, and
`hasDiffAgainstMain` alone judges the branch "still has unmerged work" forever.
Combine that with `tryMerge`'s post-merge local-branch delete **failing whenever the
sandbox still has the branch checked out**, and the relay re-pushes → re-PRs →
re-squash-merges the same branch **every tick**, minting an empty squash commit onto
`main` (and firing the deploy) each time. This actually happened: 9 empty commits +
9 redundant deploys before it was caught (2026-06-13).

**The guard — `isTipAlreadyMerged(branch, sha)`, checked before push:** ask GitHub
whether a **closed PR with `merged_at` set and `head.sha === the current local tip`**
already exists. If so, the content is already on `main` → skip push/PR/merge and
delete the local branch (best-effort). Do **not** rely on `tryMerge`'s cleanup alone:
it cannot remove a checked-out branch, which is exactly the condition that ignites the
loop. The three-dot `hasDiffAgainstMain` check stays (it cheaply filters truly-empty
branches without an API call), but it is **not** the squash filter — this is.

Operational corollaries: (a) after signaling `Relay-Merge`, have the agent `git
switch` off the branch so the local ref can be reaped next tick; (b) squash residue
already on `main` (empty commits) can't be removed without rewriting protected history
— leave it, it's inert. The guard makes the loop impossible regardless of (a).

## Operations

```bash
systemctl --user list-timers <project>-relay.timer     # next tick
journalctl --user -u <project>-relay.service -f        # logs (one line per action)
systemctl --user start <project>-relay.service         # manual one-shot
```

Log vocabulary: `pushed` / `PR created` / `PR exists` / `REFUSE` / `merge pending #N` / `merged PR #N` / `idle`.

The human's recurring job is **reviewing and merging PRs** — governance, not secret
handling. With the `Relay-Merge` trailer enabled, that becomes **per-PR opt-out**:
no trailer → human merges, as before.

## E2E acceptance test

1. In the container: `git checkout -b claude/e2e-test`, commit a doc tweak, `git checkout main`.
2. Within ~70s the journal shows `pushed claude/e2e-test` + `PR created: <url>`; PR author is `app/<project>-relay`.
3. CI runs on the PR with no approval prompt and goes green.
4. Merge (human) → branch auto-deleted; relay's next tick skips the residue (no diff vs main); deploy pipeline (e.g. Workers Builds) fires off main.

**Merge-delegation variant** (proves the trailer path end-to-end):

1. In the container, on the open branch: `git commit --allow-empty -m "chore: request merge" -m "Relay-Merge: yes"`.
2. Journal shows `pushed` (new tip) → `merge pending #N` (405 while CI re-runs — this confirms the server-side gate) → next tick `merged PR #N`, branch deleted both sides.
3. The whole loop — commit → push → PR → CI → merge → deploy — ran with zero human steps and zero sandbox credentials.
