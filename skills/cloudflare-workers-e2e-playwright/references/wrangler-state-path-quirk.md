# `wrangler dev --config` state path quirk

## The trap

`wrangler` resolves the `.wrangler/state/` directory (where local D1 sqlite, KV, R2 emulation files live) using **two different rules** depending on whether `--config` is passed:

| Invocation | `.wrangler/state/` resolution |
|---|---|
| `wrangler dev` (no `--config`) | Relative to **cwd** |
| `wrangler dev --config <path/to/wrangler.json>` | Relative to **the directory containing the config** |
| `wrangler d1 execute --local` (no `--config`) | Relative to **cwd** |

This is undocumented as a "gotcha" but visible in the docs if you read carefully — `--persist-to` is the explicit flag, and its default is "wrangler config root" which depends on how wrangler found the config.

When you build a Cloudflare Workers app with `@cloudflare/vite-plugin`, the build emits a derived `wrangler.json` into `dist/<bundle>/`. If you then run `wrangler dev --config dist/<bundle>/wrangler.json` (the natural way to test the build artifact), the state directory becomes `dist/<bundle>/.wrangler/state/` — **a brand-new empty directory**, not the one you've been using all along.

Your migrations were applied with `wrangler d1 migrations apply <db> --local` (no `--config`), which used cwd-relative `.wrangler/state/`. The two state paths are different. The wrangler dev process queries the empty sqlite. You get:

```
D1_ERROR: no such table: users: SQLITE_ERROR
```

## Physical evidence (how to confirm the trap)

```bash
$ ls -la packages/web/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/
-rw-r--r--  139264  ...sqlite       # ← migrated, 139 KB
-rw-r--r--   32768  ...sqlite-shm
-rw-r--r--   70072  ...sqlite-wal

$ ls -la packages/web/dist/routine_tasks/.wrangler/state/v3/d1/miniflare-D1DatabaseObject/
-rw-r--r--    4096  ...sqlite       # ← brand-new empty, 4 KB
-rw-r--r--   32768  ...sqlite-shm
-rw-r--r--       0  ...sqlite-wal
```

A 4 KB sqlite file is the empty-database default. A 139 KB sqlite has tables in it. If you see two of them at different paths, you've confirmed the split.

## Symptom progression

The trap presents differently from the CSP trap (see `csp-vs-vite-hmr-preamble.md`):

- Tests that **don't touch the DB** pass (security headers, `/health`, `/api/auth/me` returning 401 because no session cookie exists yet)
- Tests that **do touch the DB** fail with `D1_ERROR: no such table: <name>` — usually `users` because that's the first table register touches
- The browser console shows no CSP errors (React mounts fine — the build artifact has no HMR preamble)
- The wrangler dev process logs the SQLite error explicitly

If you see all of the above, you have this trap. The fix below resolves it.

## The fix

Pass `--persist-to` to pin the state path to the cwd-relative location, so it matches where `wrangler d1 execute --local` writes:

```json
"e2e:server": "pnpm build && pnpm exec wrangler dev --config dist/<bundle>/wrangler.json --persist-to .wrangler/state --port 5173"
```

`--persist-to .wrangler/state` is interpreted relative to **cwd** (the directory you run the command from). Since your test setup runs from `packages/<pkg>/` (where `package.json` lives), this resolves to `packages/<pkg>/.wrangler/state/`, matching what `wrangler d1 execute` uses.

After the fix:
- Both wrangler dev and `dev-reset.ts` (which runs `wrangler d1 execute --local`) read/write the same sqlite file
- Migrations applied via `pnpm db:migrate` are visible in e2e
- The empty `dist/<bundle>/.wrangler/` directory stops being created (you can `rm -rf` the leftover one)

## Why isn't this the default?

Wrangler's default makes some sense in isolation: if you `cd` into a deployed bundle directory and run `wrangler dev`, you'd want a clean state, not whatever happened to be in the parent's cwd. The trap arises when you stay in the development cwd but point at a different config file — wrangler picks the config-relative path, not what your intuition expects.

A safer default would be "use cwd unless `--persist-to` is explicit". But the current behavior is the documented one, and changing it would break existing setups that rely on per-bundle isolation.

## Related: wrangler dev startup time

`pnpm build && wrangler dev` adds ~10-15 seconds to e2e startup compared to `vite dev` (which serves immediately with HMR). If iteration speed becomes a bottleneck:

- Run `pnpm run e2e:server` in a separate terminal once, leave it running
- Set `webServer.reuseExistingServer: true` in `playwright.config.ts`
- Subsequent `pnpm e2e` invocations reuse the running server

But don't co-locate this with `pnpm dev` on the same port — Vite dev still has the CSP trap. Pick one or the other; document the choice in `e2e/README.md`.

## Variant: a dedicated e2e state dir (kokemusu, 2026-09-02)

The invariant is **"every command that touches the e2e database resolves the same sqlite"**, not the literal `.wrangler/state`. Pointing everything at `--persist-to .wrangler/e2e` instead satisfies it and adds a property: a run can wipe its database without touching the `pnpm dev` state (registered passkeys, real-looking posts) that lives in `.wrangler/state`.

```ts
// e2e/env.ts
export const E2E_PERSIST_DIR = ".wrangler/e2e";
// e2e/helpers/db.ts — every call hardcodes --local and the dir
wrangler(["d1", "migrations", "apply", "<db>", "--local", "--persist-to", E2E_PERSIST_DIR]); // globalSetup, idempotent
wrangler(["d1", "execute", "<db>", "--local", "--persist-to", E2E_PERSIST_DIR, "--command", sql]);
```
```json
"e2e:server": "pnpm build && node e2e/prepare-config.ts && wrangler dev --config dist/<bundle>/wrangler.json --persist-to .wrangler/e2e --ip 127.0.0.1 --port 5183"
```

The migrations dir and `database_id` come from the same derived config in both cases, so the sqlite file name (a hash of the database id) matches. First run creates the directory. `wrangler d1 execute --json` on the same dir is also how the golden path asserts what is **at rest** (an encrypted `k1.…` envelope, never the plaintext) without going through the API.

## The same config-relative rule applies to `.dev.vars`

`@cloudflare/vite-plugin` 1.x copies `.dev.vars` into `dist/<bundle>/.dev.vars`, and wrangler reads `.dev.vars` from the config's directory (`path.resolve(dirname(configPath), ".dev.vars")` in `wrangler-dist/cli.js`). With `--config dist/<bundle>/wrangler.json` the e2e server therefore inherits the developer's `DEV_CSP=1` and dev `ORIGIN` unless the prepare step deletes the copy (and writes the e2e values into `cfg.vars`) or every key is passed with `--var` (CLI wins; measured `--var` > `.dev.vars` > `vars`, wrangler 4.125).

## Generalizable lesson

**State persistence paths are a common source of "works in some commands, not others" bugs in monorepos / multi-stage build setups.** Whenever a tool defaults to "relative to <X>", check what X is for each invocation. Differences between invocations of the same tool (with vs without `--config`, with vs without `--cwd`, run from different directories) silently use different state.

The general remedy: pass the path **explicitly** in scripts that use the tool. `--persist-to .wrangler/state` here. Equivalent in other tools: `--config-file` for ESLint, `--cwd` for many CLIs, `WORKSPACE_ROOT` env vars for Bazel/Pants.

Don't trust defaults to be consistent across invocations. They aren't.
