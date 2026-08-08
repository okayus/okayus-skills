# Playwright config recipe

Full working `playwright.config.ts` for a Cloudflare Workers + Vite + Hono app with strict CSP, including the explanatory comments you should ship inline so the next person doesn't undo the careful choices.

## `playwright.config.ts`

```typescript
import { defineConfig } from "@playwright/test";

// e2e is run against the **build artifact served by `wrangler dev`**, NOT `vite dev`.
//
// Why: Vite dev mode injects an inline `<script>` (React Fast Refresh / HMR preamble)
// into every HTML response. This inline script collides with our production-equivalent
// strict CSP (`script-src 'self'`), is blocked by the browser, and breaks React mount
// on `page.reload()` and SPA-fallback paths. Two non-fixes were considered and rejected:
//   - "Relax CSP in dev": diverges dev CSP from prod CSP, defeats the purpose of e2e
//     (which is to catch regressions in the production configuration).
//   - "Patch the preamble out of Vite": fragile, breaks on Vite version bumps.
//
// The build artifact (`dist/<bundle>/index.js` + `dist/client/index.html`) does NOT
// contain the HMR preamble — it's only injected by Vite dev. So strict CSP works.
// `wrangler dev` honors `run_worker_first: true` (unlike @cloudflare/vite-plugin@0.1.x
// which silently bypasses the Worker for `/`), so all paths exercise the same Hono
// middleware as production.
//
// `--persist-to .wrangler/state` is required: without it, `wrangler dev --config
// dist/<bundle>/wrangler.json` resolves the local D1 sqlite path relative to the
// CONFIG file's directory (= `dist/<bundle>/.wrangler/state/`, a fresh empty file)
// instead of cwd. Migrations were applied via `wrangler d1 migrations apply --local`
// from the package root, which uses cwd-relative state. The two paths must match or
// you get `D1_ERROR: no such table: users`.
//
// Trade-offs:
//   - `pnpm build && wrangler dev` adds ~10-15 sec to e2e startup vs `vite dev`.
//     For dev-iteration speed, run `pnpm run e2e:server` once in a separate terminal
//     and let `reuseExistingServer: true` skip the rebuild on subsequent `pnpm e2e`.
//   - Same port as `vite dev` (5173): `pnpm dev` and `pnpm run e2e:server` are
//     mutually exclusive. Document this in `e2e/README.md`.

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:5173",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm run e2e:server",
    url: "http://localhost:5173",
    reuseExistingServer: true,
    // build (~3s) + wrangler dev startup (~5s) + buffer
    timeout: 180_000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
```

## `package.json` scripts

```json
{
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "e2e": "playwright test",
    "e2e:install": "playwright install chromium",
    "e2e:server": "pnpm build && pnpm exec wrangler dev --config dist/<your-bundle>/wrangler.json --persist-to .wrangler/state --port 5173",
    "e2e:ui": "playwright test --ui"
  }
}
```

Replace `<your-bundle>` with the Worker name from your `wrangler.jsonc` (e.g. `routine_tasks` for `name: "routine-tasks"`). Inspect `dist/` after a build to confirm the directory name.

## Docker-sandbox variant (three divergences)

This recipe targets a normal host. Running inside the `claude-code-docker-sandbox`
container changes three things — full story in the `playwright-e2e-in-docker-sandbox`
skill:

1. **No `e2e:install`.** The egress firewall blocks the Playwright CDN at runtime; the
   browser is baked into the image at build time instead (`INSTALL_PLAYWRIGHT` build arg).
2. **`127.0.0.1`, not `localhost`.** `baseURL`, the `--ip` bind, and `ORIGIN` all use the
   literal IP — a `localhost` bind stalls on dual-stack resolution in-container.
3. **Gated `--no-sandbox` + config strip.** `launchOptions: process.env.DEVCONTAINER ?
   { args: ["--no-sandbox"] } : {}`, and a `prepare-config.ts` strips the rate-limit
   binding (`unsafe` / `ratelimits`) from the built config.

## Why these specific settings

- `fullyParallel: false`, `workers: 1`: local D1 is a single sqlite file, parallel tests would corrupt state. Force serial execution.
- `retries: 0`: e2e flakiness is a debugging signal, not a transient annoyance to retry through. If a test is flaky, fix it.
- `trace: "retain-on-failure"`, `video: "retain-on-failure"`, `screenshot: "only-on-failure"`: capture rich debug data on failure, nothing on success (keeps `test-results/` from growing). The trace zip is the most valuable — open with `playwright show-trace test-results/.../trace.zip`.
- `reuseExistingServer: true`: enables the "pre-start the server, iterate fast" workflow.
- `timeout: 180_000` on webServer: build + wrangler dev startup time, with margin. Don't tune this lower; CI runners and slower machines need the headroom.

## What to put in `.gitignore`

```
# Playwright artifacts (per-run, not committed)
test-results/
playwright-report/
```

These directories are rebuilt every run. Don't commit them.

## What to put in `e2e/README.md`

A 30-line README that covers:

1. **Setup**: `pnpm e2e:install` (Chromium download), `.dev.vars` required values
2. **Running**: `pnpm e2e` directly, OR `pnpm e2e:server` in one terminal + `pnpm e2e` in another for fast iteration
3. **Mutual exclusion with `pnpm dev`**: same port, kill one before running the other
4. **Trap signposts**: if you see "no such table: users", check `--persist-to`. If you see "inline script violates CSP", check that you're not running against `vite dev`
5. **3 specs covered, why narrow**: link to test-scope-philosophy.md or your own equivalent

Future contributors who skip the README will rediscover the traps the hard way; future contributors who read it will save the hours.

## Common pitfalls to call out in the README

| Symptom | Likely cause |
|---|---|
| `Port 5173 already in use` | `pnpm dev` (Vite) is running. Kill it: `pkill -f "vite dev"`. |
| `D1_ERROR: no such table: users` | `--persist-to` missing or wrong path. Check `e2e:server` script. |
| `Executing inline script violates CSP` | Running against `vite dev`, not the build. Check `webServer.command`. |
| Test passes locally, fails in another developer's setup | `.dev.vars` differs. Compare. |
| WebAuthn fails with "RP_ID mismatch" | `.dev.vars` has `RP_ID=<prod-domain>`. Set `RP_ID=localhost` for local e2e. |
| `Could not find migrations directory` | Running wrangler dev from wrong cwd. Confirm `pnpm e2e:server` runs from package root. |

These six covers ~95% of confused-on-Slack questions for this kind of setup.
