---
name: agent-status-hub
description: Keep an AI coding agent oriented across sessions WITHOUT a bloated status.md. Split repository context by lifetime — a hard-capped "now" hub (docs/status.md, 40 lines / 3 KB, four fixed headings), an append-only milestone log (docs/log.md, never auto-loaded), per-topic plans deleted when done, and ADRs — then inject the hub deterministically with a Claude Code SessionStart hook, write it back with a manual /handoff skill, and gate the cap in CI. Use when status.md / PROGRESS.md / project-status.md keeps growing, when CLAUDE.md has filled up with "next actions" and strikethrough history, when a new session (or a sandboxed container session) has to rediscover where the project stands, or when asked how to carry progress, roadmap or handoff notes between Claude Code sessions. Covers why CLAUDE.md @imports and auto memory don't solve it (imports load at launch anyway; auto memory is machine-local, so host and container keep separate memories), which hook events can inject context (SessionStart stdout does, PreCompact / Stop stdout is discarded), and the measured bloat that motivated the design.
license: MIT
compatibility: Designed for Claude Code (hooks, skills, CLAUDE.md). The file layout and rules are agent-agnostic; the injection / write-back mechanics use Claude Code's SessionStart hook and project skills. Works unchanged inside a Docker sandbox (claude-code-docker-sandbox) because everything is committed to the repo.
metadata:
  author: okayus
  version: "0.1.0"
---

# Agent status hub: repository context across sessions

Every agent session starts empty. The usual fix — "read `status.md` first, update it as you go" — works for a month and then the file is 200–370 lines of mixed plans, research dumps and completed-phase history, loaded in full at every start and edited in half of all commits. This skill replaces the single file with **three files of different lifetimes**, puts a **hard cap** on the only one that is loaded every session, and makes loading and write-back **mechanical** instead of an instruction the agent may or may not follow.

First applied to kokemusu on 2026-08-23 (PR #6). The measurements below come from the author's own repositories.

## When to use this skill

- A repo has a `status.md` / `PROGRESS.md` / `docs/project-status.md` that keeps growing, or a CLAUDE.md that has become a progress file (strikethrough history, "next actions" with dates)
- A sandboxed / autonomous agent (see `claude-code-docker-sandbox`) must pick up where the last session stopped without a human re-explaining
- You are asked "how should Claude remember where this project stands between sessions?"
- NOT for: team task tracking with assignees and due dates (use the issue tracker; this skill is the *agent's* orientation layer on top of it), or per-file coding conventions (those belong in CLAUDE.md / `.claude/rules/`)

## The problem, measured (2026-08-23)

| Repo | File | Size | Commits touching it |
|---|---|---|---|
| portfolio | `status.md` | 368 lines / 20 KB — research notes, a docker-compose template, Phase 1.0–1.4 completion records | — |
| mazuoboeru | `docs/project-status.md` | 204 lines; biggest sections "what is needed" 41, "roadmap" 40, "what runs in prod" 32 | **44 of 88** |
| nyalog | `docs/status.md` | 50 lines after a 2026-08-05 rewrite into a hub, but its "completed phases" section is append-only and grows again | **54 of 97** |
| kokemusu | `CLAUDE.md` | 69 lines but **14.4 KB**, lines of 1,319 chars; a "next actions" section of 3.3 KB with ~~strikethrough~~ history | 6 of 14 |

Root cause: three kinds of information with different lifetimes share one file, and a "read it first" rule loads all of it every session.

| Kind | Changes | Belongs in |
|---|---|---|
| now, next step, blockers | every session, rewritten | a small hub with a hard cap |
| plans, research results | written once, read when executing | one file per topic, deleted when done |
| completed history | append-only, grows forever | git log / PRs / a one-line log that is never auto-loaded |

## Design

```
CLAUDE.md               conventions and pointers only — no progress, no history, no "next actions"
docs/status.md          the NOW hub. Hard cap 40 lines / 3 KB. Four fixed H2 headings:
                        phase / next 3 moves / blockers & waiting-on-human / open PRs
docs/log.md             append-only, newest first, one line per milestone (date, what, #PR / ADR / skill).
                        Never auto-loaded; `head -20 docs/log.md` on demand
docs/plans/<topic>.md   created when work on a topic starts; deleted when done (the conclusion lives in an ADR or one log line)
docs/adr/, CONTEXT.md   decisions and vocabulary (unchanged; see `grill-with-docs`)
docs/roadmap.md         phases and checkboxes only; no narratives of how things got done
```

Three rules keep it from regrowing:

1. A finished item in `status.md` is **deleted and moved** to the top of `log.md` as one line. Strikethrough is forbidden — it is the first symptom of bloat.
2. A `status.md` section longer than 8 lines becomes `docs/plans/<topic>.md` plus a one-line pointer.
3. "Done" is recorded in exactly three places: git, PRs, `log.md`. Never in `status.md` or CLAUDE.md.

The cap is enforced by a script (`check-status.sh`: ≤ 40 lines, ≤ 3,000 bytes, no `~~`, exactly the four headings) that both the write-back skill and CI run. 40 lines is enough for a solo project's "now"; 3 KB keeps Japanese text (3 bytes/char) honest.

## Mechanisms (Claude Code)

All four live **in the repository**, so a sandboxed container session (bind-mounted repo, committed `.claude/settings.json`) behaves exactly like the host. Templates for every file: [references/templates.md](references/templates.md). Doc-verified facts behind the choices: [references/claude-code-facts.md](references/claude-code-facts.md).

1. **SessionStart hook injects the hub.** `.claude/hooks/session-start.sh` prints `docs/status.md`, the first 5 lines of `docs/log.md` and `git log --oneline -5`; registered in the committed `.claude/settings.json` under `hooks.SessionStart` (no matcher → fires on `startup`, `resume`, `clear` and `compact`). A SessionStart hook's **stdout is added to Claude's context**; the `compact` source means the "next 3 moves" survive compaction without relying on the summary. This replaces "read status.md first" (advisory) with something that always happens (deterministic).
2. **`/handoff` skill writes it back.** `.claude/skills/handoff/SKILL.md` with `disable-model-invocation: true` (only the human triggers it, at the end of a session). Steps: gather state → add finished milestones to the top of `log.md` → **rewrite** `status.md` (never append) → delete finished plans, tick roadmap boxes → run `check-status.sh` until OK → commit on the working branch (branch off if on `main`) → report the first "next move" as the next session's starting point.
3. **CI gate.** `bash .claude/hooks/check-status.sh docs/status.md` as the first step of the required CI job: a PR that pushes the hub over the cap cannot merge. Cheap, and the only enforcement that survives an agent ignoring instructions.
4. **CLAUDE.md diet.** Move "next actions" to `status.md`, completion notes to `log.md`, long decision bullets to one-line pointers at the ADR / docs. Add three lines: the hub rules, "update via `/handoff`", and `"When compacting, always keep the list of modified files and the first item of 次の 3 手"` (the documented way to steer compaction). kokemusu went from 69 lines / 14.4 KB to 45 lines / 7.8 KB; the official target is under 200 lines, and `/doctor` proposes trims.

## Install (≈ 15 minutes)

1. Copy the templates: `docs/status.md`, `docs/log.md` (seed it with the last few milestones from `git log`), `.claude/hooks/session-start.sh`, `.claude/hooks/check-status.sh` (`chmod +x` both — git keeps the bit), `.claude/skills/handoff/SKILL.md`.
2. Add the `hooks.SessionStart` block to the **committed** `.claude/settings.json` (not `settings.local.json`, or the container won't get it). Use `${CLAUDE_PROJECT_DIR}/.claude/hooks/session-start.sh` as the command.
3. Add the CI step before dependency install.
4. Diet CLAUDE.md and point `roadmap.md` / any "current state" section at `status.md`.
5. Verify: `bash .claude/hooks/check-status.sh` prints `OK`; `CLAUDE_PROJECT_DIR=$PWD bash .claude/hooks/session-start.sh` prints the hub; in a new session `/hooks` lists SessionStart and the first message shows the injected hub; `/context` shows CLAUDE.md shrank.

If the headings are translated, change them in **both** `status.md` and `check-status.sh` — the script pins them literally.

## Inside a Docker sandbox

- The repo is bind-mounted at `/workspace` and `CLAUDE_PROJECT_DIR` resolves there, so the hook, the skill and the check script need **no rebuild and no extra mount**.
- **Auto memory does not cross the boundary.** The container's `CLAUDE_CONFIG_DIR` (`/home/node/.claude`, a named volume) holds its own `projects/<repo>/memory/`; the host has another. Anything both sides must know goes in the repo — the hub — never in memory. Keep auto memory for preferences and corrections.
- Session transcripts are per machine too: `claude --continue` inside the container resumes container sessions only. The hub is what makes a host session and a container session interchangeable.
- Hooks run under `bypassPermissions` (the container default from `claude-code-docker-sandbox`) like anywhere else; deny rules are unaffected.

## Alternatives considered

- **GitHub Issues / Projects as the primary store** — fine for a human backlog, but a sandbox token scoped to Contents + Pull requests cannot write issues, and `gh api` is typically denied. Public repos can still be *read* unauthenticated. Use issues for backlog items that don't need to be in context; keep the agent's "now" in the repo.
- **`@docs/status.md` import in CLAUDE.md** — imports load at launch, so it costs the same context, and there is no re-injection after `/compact` beyond CLAUDE.md's own reload; the hook is explicit about when it fires.
- **Sharing auto memory between host and container** (`autoMemoryDirectory`) — absolute paths differ per environment and a repo-relative path isn't allowed; the value doesn't cover the friction.
- **A Stop / PreCompact hook that forces a status update** — their stdout is discarded and blocking every turn end is heavy-handed; a manual `/handoff` plus the CI gate is enough.

## Verified on kokemusu (2026-08-23) — and what is still open

- Hub 23 lines / 1.5 KB; CLAUDE.md 69 → 45 lines, 14.4 → 7.8 KB; `check-status.sh` green locally and as the first CI step of PR #6 (`ci` passed in 27 s with the step).
- The hook invoked through the exact settings command string (`${CLAUDE_PROJECT_DIR}/.claude/hooks/session-start.sh`) prints hub + log + git on the host.
- UNVERIFIED: the hook firing inside the sandbox container on the next `claude` start (settings.json is bind-mounted; nothing suggests otherwise, but it has not been observed yet).
- UNVERIFIED: the first real `/handoff` run end to end (the skill text was written with the deployment, not exercised).
- UNVERIFIED: whether SessionStart output on the `compact` source is enough to keep the agent on track in a long autonomous loop, or whether the CLAUDE.md compaction instruction is also needed in practice.
