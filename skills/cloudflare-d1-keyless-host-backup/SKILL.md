---
name: cloudflare-d1-keyless-host-backup
description: Back up every Cloudflare D1 database you own from ONE host-side systemd timer, with no Cloudflare credential stored in GitHub, in a repo, or in a sandbox — it reuses the host's existing `wrangler login`. Use when the repo is public or keyless (so `cloudflare-d1-weekly-backup-via-pr` does not fit), when "we will add backups later" has been said more than once, or before merging any D1 migration. Ships the backup script (export → restore rehearsal in an in-memory SQLite → row counts → gzip outside every repo → rotation → desktop alert on failure or on a table that lost half its rows), a restore tool, and a Time Travel bookmark helper for migration PRs. Covers the trap that a raw `wrangler d1 export` dump can NOT be imported back into D1 (tables are not ordered parent-first and D1 always enforces foreign keys — measured), that a running export blocks the database, that FTS5/virtual tables break export, the minimal PATH of systemd user units, and why `pnpm exec wrangler` on the host wrecks a container's node_modules.
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets a Linux host with systemd user units, Node 22.13+ (for `node:sqlite`; verified on 24.19), and projects that already have `wrangler` in `node_modules` and a host-side `wrangler login`. No Cloudflare API token, no GitHub secret, no new dependency.
metadata:
  author: okayus
  version: "0.1.0"
---

# Cloudflare D1 backup from the host, keyless

**The shape in one sentence**: a systemd user timer on the developer's machine runs `wrangler d1 export --remote` for every database once a week, proves each dump loads, and keeps the gzipped dumps in a directory that belongs to no repository.

This is the sibling of `cloudflare-d1-weekly-backup-via-pr`. That skill commits dumps to a private repo through GitHub Actions and needs a `CLOUDFLARE_API_TOKEN` secret. It cannot be used when the repo is public (the dump is user data) or when the project is deliberately keyless (`cloudflare-workers-builds-keyless-deploy`). "We will add backups once there is a variant that fits" is how a production app ends up with no backup at all while migrations keep shipping. This is that variant.

## When to use this skill

- The repo is public, or the project has no Cloudflare credential in GitHub and you want to keep it that way
- You have several small D1 databases and one machine that is on most days
- A migration PR is about to be merged and there is no backup yet (run it by hand, then add the timer)

Do **not** use for:

- Databases whose export takes minutes. A running export blocks every other request to that database; move to a replica or an R2-based pipeline
- Databases with virtual tables (FTS5). Export fails outright (see Trap 3)
- Anything that must survive the loss of this one machine. The dumps are local; copy the directory elsewhere if that matters

## Deliverables (completion criteria)

- [ ] `~/.config/d1-backup/{d1-backup.mjs,d1-bookmark.mjs,d1-restore-sql.mjs,databases.json}` installed, directory `0700`
- [ ] One manual run is green for every database and `~/backups/d1/last-run.json` shows plausible row counts
- [ ] One restore drill done: `d1-restore-sql.mjs` output imported into a **local** D1 (`--local --persist-to <tmp>`) and row counts compared
- [ ] `d1-backup.timer` enabled; `systemctl --user list-timers d1-backup.timer` shows the next run
- [ ] One run under systemd's environment is green (Trap 4)
- [ ] Each project's migration runbook says: before merging a migration PR, `d1-bookmark.mjs <app> <pr>`

## Install

```sh
SKILL=~/.claude/skills/cloudflare-d1-keyless-host-backup
install -d -m 700 ~/.config/d1-backup
install -m 644 $SKILL/scripts/*.mjs ~/.config/d1-backup/
$EDITOR ~/.config/d1-backup/databases.json      # see below, then chmod 600
node ~/.config/d1-backup/d1-backup.mjs --list   # wrangler=ok for every line?
node ~/.config/d1-backup/d1-backup.mjs          # first real run

install -m 644 $SKILL/systemd/d1-backup.{service,timer} ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now d1-backup.timer
```

The installed copies are plain copies on purpose (a timer must not depend on which branch a checkout is on). After updating the skill, re-run the two `install` lines; `diff ~/.config/d1-backup/d1-backup.mjs $SKILL/scripts/d1-backup.mjs` shows drift.

`databases.json`:

```json
{
  "outDir": "~/backups/d1",
  "keep": 26,
  "databases": [
    { "app": "myapp", "cwd": "~/src/myapp/packages/web", "database": "myapp-db", "repo": "me/myapp" }
  ]
}
```

`cwd` is the directory that holds both `wrangler.jsonc` and `node_modules/.bin/wrangler`. `repo` is only used by `d1-bookmark.mjs` to comment on a PR. `keep` is the number of dumps kept per database (26 weekly dumps = half a year).

## What one run does

1. For each database, one at a time: `<cwd>/node_modules/.bin/wrangler d1 export <database> --remote --output=<tmp>`
2. **Restore rehearsal**: loads the dump into an in-memory SQLite (`node:sqlite`), counts rows per table, runs `PRAGMA foreign_key_check` and `PRAGMA integrity_check`. A dump that does not load fails the run
3. Writes `<outDir>/<app>/<database>-<UTC stamp>.sql.gz` (`0600`), reads it back, prunes to `keep`
4. Compares row counts with the previous run. A table that had 20+ rows and lost more than half is reported. This is what turns a silent mass delete (an unintended `ON DELETE CASCADE` during a table rebuild, say) into something you hear about while Time Travel can still undo it
5. Writes `<outDir>/last-run.json`; on failure or warning sends a desktop notification (`notify-send`) and, if `D1_BACKUP_DISCORD_WEBHOOK` is set in the unit, a Discord message. Exit code 1 on failure, so `systemctl --user status d1-backup` shows `failed`

## Before merging a migration PR

Time Travel is always on and free (7 days of history on the Free plan, 30 on Paid), and a restore is itself undoable. It is the fast path for "the migration ate my rows"; the weekly dump is for everything older than the retention window. Take a named point right before the merge:

```sh
node ~/.config/d1-backup/d1-bookmark.mjs myapp 123   # prints the bookmark, comments on PR #123
```

This has to happen on the host: a sandboxed agent has no Cloudflare credential by design. Make it the merge gate for migration PRs instead of a human saying "merge it": the agent can check that the PR carries a bookmark comment, and refuse to arm auto-merge when it does not.

## Restore

Within the retention window, prefer Time Travel:

```sh
cd <cwd> && ./node_modules/.bin/wrangler d1 time-travel restore <database> --bookmark=<bookmark>
```

From a dump, **do not import the raw file** (Trap 1). Reorder it first, rehearse locally, then import:

```sh
node ~/.config/d1-backup/d1-restore-sql.mjs ~/backups/d1/myapp/myapp-db-<stamp>.sql.gz > /tmp/restore.sql
cd <cwd>
./node_modules/.bin/wrangler d1 execute <database> --local --persist-to /tmp/restore-drill --file=/tmp/restore.sql
./node_modules/.bin/wrangler d1 execute <database> --local --persist-to /tmp/restore-drill --command "select count(*) from <table>"
# only then, against a NEW empty database (never on top of the damaged one):
./node_modules/.bin/wrangler d1 execute <new-database> --remote --file=/tmp/restore.sql
rm -rf /tmp/restore.sql /tmp/restore-drill     # they hold production data
```

`--persist-to` keeps the drill out of the project's `.wrangler/state`, so the dev database is untouched.

## Trap 1: the raw export cannot be imported back into D1

`wrangler d1 export` writes tables in an order that is not parent-first. Measured 2026-09-20 (wrangler 4.125.0, an 8-table Drizzle schema): the dump inserts into `credential` (which references `user`) 300 lines before `CREATE TABLE user`. With foreign keys enforced this stops at:

```
✘ [ERROR] no such table: main.user: SQLITE_ERROR
```

The `PRAGMA defer_foreign_keys=TRUE` at the top of the dump does not help: it defers constraint *violations*, while a missing parent table is an error when the INSERT is prepared. D1 always enforces foreign keys (it ignores `PRAGMA foreign_keys=OFF` — see `cloudflare-d1-drizzle-migration`), so this is the behaviour you get on import. Reproduced with `d1 execute --local --file` on the raw dump (fails) and on the `d1-restore-sql.mjs` output (succeeds, row counts equal). The remote import path was not exercised; assume the same until you have measured otherwise.

Consequences:

- "I ran `wrangler d1 export` before the migration" is **not** a restore plan until the dump has been loaded somewhere. That is why the backup script rehearses every dump, with enforcement off, and then runs `foreign_key_check`
- Whether your schema is affected depends on table creation order; a schema that happens to be parent-first will import fine and hide the problem until a rebuild migration reorders it

## Trap 2: a running export blocks the database

From the D1 docs: "A running export will block other database requests." For a sub-megabyte database this is a few seconds (measured: 4 databases, 3.2 MB of SQL in total, 19 s wall time including four wrangler start-ups), but it is why the timer runs at 04:40 and why databases are exported one at a time. If a Cron Trigger of yours fires at a fixed minute, keep the timer away from it.

## Trap 3: virtual tables break export

"Export is not supported for virtual tables, including databases with virtual tables." The day you add FTS5, this backup starts failing (you will get the notification). The documented workaround is to drop the virtual tables, export, and recreate them; at that point this skill is the wrong tool and the backup needs a different design.

## Trap 4: systemd user units have a minimal PATH

`node_modules/.bin/wrangler` is a shell shim that execs `node`. Under `systemd --user` the PATH is `/usr/local/bin:/usr/bin:/bin`-ish, so a node installed by mise/nvm/fnm is not found and the unit fails while the same command works in your shell. The unit sets `Environment=PATH=…` explicitly. Prove it once without waiting a week:

```sh
systemd-run --user --wait --collect -p "Environment=PATH=$HOME/.local/share/mise/installs/node/lts/bin:/usr/local/bin:/usr/bin:/bin" \
  ~/.local/share/mise/installs/node/lts/bin/node ~/.config/d1-backup/d1-backup.mjs <one-small-app>
```

## Trap 5: never `pnpm exec wrangler` / `npx wrangler` on the host

When the project's `node_modules` was installed inside a container (bind mount), `pnpm exec` on the host sees a different store and, with pnpm 11, re-installs — `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` if you are lucky, a wrecked `node_modules` for the container if you are not. `npx` would download and run a second wrangler outside the lockfile. The scripts call `<cwd>/node_modules/.bin/wrangler` directly, which is also the only form that keeps the wrangler version pinned by the project.

## Trap 6: `Linger=no` means "only while logged in"

User timers run while the user manager runs. Without lingering that is "while you are logged in", so a 04:40 job on a machine that sleeps would never fire. `Persistent=true` runs a missed job at the next login instead. If you want it to run with nobody logged in: `loginctl enable-linger $USER` (then notifications have no session to land in; set the Discord webhook).

## Trap 7: the login is OAuth, and it can lapse

`wrangler login` stores a refresh token in `~/.config/.wrangler/config/default.toml`; non-interactive runs refresh it silently. If it is revoked or expires, every export fails with an auth error, the unit goes `failed`, and the notification says so. Fix: `wrangler login` from any project, then `systemctl --user start d1-backup`.

## What this does not cover

- **R2 objects.** Decide per bucket (`cloudflare-r2-private-image-upload` has the no-PITR discussion). Downscaled copies whose originals live on phones can be an accepted loss; originals cannot
- **Secrets.** A database restored from a dump is useless if the key that encrypts its contents is gone. Keep such keys in a password manager and rehearse decrypting one production row with the stored value
- **Off-machine copies.** `~/backups/d1` is one disk. `rsync` it somewhere if the machine is the single point of failure
