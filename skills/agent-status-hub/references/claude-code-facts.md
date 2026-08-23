# Claude Code facts the design rests on (verified 2026-08-23)

Sources: https://code.claude.com/docs/en/memory.md · hooks.md · skills.md · sessions.md · best-practices.md

## CLAUDE.md

- Loaded into context at the start of every session, delivered as a user message after the system prompt — advisory, not enforced. Target **under 200 lines**; a file over 4 MiB is skipped entirely. Bloated files reduce adherence ("Claude ignores half of it").
- Best-practices exclude list includes **"Information that changes frequently"** and "Long explanations" — i.e. progress and history do not belong there.
- `@path` imports are expanded **at launch** (max depth 4, skipped inside code spans); they organise text but **do not reduce context**.
- Block-level HTML comments are stripped before injection (free maintainer notes).
- Project-root CLAUDE.md survives `/compact`: it is re-read from disk and re-injected. Conversation-only instructions do not survive.
- `/doctor` proposes trims for content derivable from the codebase; `/context` lists what loaded.
- Recommended compaction steering: a CLAUDE.md line such as "When compacting, always preserve the full list of modified files and any test commands".

## Auto memory

- `~/.claude/projects/<repo>/memory/MEMORY.md` (index, first **200 lines or 25 KB** loaded) plus topic files read on demand. Per git repository, shared across worktrees.
- **Machine-local**: "Files are not shared across machines or cloud environments." A container with its own `CLAUDE_CONFIG_DIR` therefore keeps a separate memory from the host.
- `autoMemoryDirectory` must be an absolute path or start with `~/` — no repo-relative option.
- Intended for preferences, corrections and project context Claude can't derive from code — not for progress tracking.

## Hooks

- Event list includes `SessionStart`, `UserPromptSubmit`, `PreCompact`, `PostCompact`, `Stop`, `SessionEnd`, `InstructionsLoaded`, `FileChanged`.
- **`SessionStart`**: matchers `startup`, `resume`, `clear`, `compact`, `fork`; omit the matcher to fire on all. "Claude Code adds plain-text stdout as context that Claude can see and act on." Input JSON carries `session_id`, `transcript_path`, `cwd`, `model`.
- **`PreCompact`** (`manual` / `auto`): stdout discarded; exit 2 blocks compaction. **`Stop`**: stdout discarded; exit 2 prevents stopping (overridden after 8 consecutive blocks). **`SessionEnd`**: cannot block, stdout discarded.
- Hook shape: `{"hooks": {"SessionStart": [{"matcher": "...", "hooks": [{"type": "command", "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/x.sh", "timeout": 10}]}]}}`. Types: `command`, `http`, `mcp_tool`, `prompt`, `agent`.
- Hooks are deterministic ("run regardless of what Claude decides"); CLAUDE.md is not.

## Skills

- `.claude/skills/<name>/SKILL.md` and `.claude/commands/<name>.md` are the same mechanism; a skill's body loads **only when used**.
- `disable-model-invocation: true` → only the user can run it (`/name`); use for side-effectful workflows. `user-invocable: false` → only Claude.
- `$ARGUMENTS`, `$0`/`$1`, named `arguments`; `argument-hint` for autocomplete; `allowed-tools` grants for the invoking turn; `context: fork` to run in a subagent.

## Sessions

- Stored per project directory as JSONL under `~/.claude/projects/<project>/`; resume with `--continue`, `--resume <name|id>`, `/resume`, `--from-pr <n>`; name with `-n` / `/rename`.
- On a Pro/Max plan, resuming a session idle > ~1 h and > 100k tokens offers "Resume from summary" (runs `/compact`) vs full.
- Sessions are local to the machine — a host session and a container session never see each other's transcript.
- Best-practices pattern for large work: have Claude write a spec/plan file, then **start a fresh session** to execute it — the reason `docs/plans/<topic>.md` lives in the repo.
