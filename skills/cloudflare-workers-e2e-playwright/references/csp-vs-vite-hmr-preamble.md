# Strict CSP × Vite HMR preamble — full trace

## The collision in concrete terms

`@vitejs/plugin-react` injects this inline `<script>` into every HTML response served by `vite dev`:

```html
<script type="module">
  import RefreshRuntime from "/@react-refresh";
  RefreshRuntime.injectIntoGlobalHook(window);
  window.$RefreshReg$ = () => {};
  window.$RefreshSig$ = () => (type) => type;
  window.__vite_plugin_react_preamble_installed__ = true;
</script>
```

This sets globals (`$RefreshReg$`, `$RefreshSig$`, the install flag) that React's transformed modules expect to exist before they execute. It's part of React Fast Refresh / HMR.

It is **inline**. Not loaded from `/@react-refresh` directly via `<script src="...">` — that import statement is *inside* an inline module.

If your CSP is `script-src 'self'` (no `'unsafe-inline'`, no nonce), the browser blocks this inline `<script>` from executing. The transformed app modules then load via `<script type="module" src="/src/main.tsx">` (which IS allowed by `'self'`) and immediately try to use `window.$RefreshReg$` — undefined — and either crash or behave unpredictably depending on the React version. The result on the user's screen: no React mount, no `useEffect` firing, no API calls, blank page.

## How the bug presents in Playwright

You see this in `test-results/<test>/error-context.md`:

```
Error: expect(locator).toBeVisible() failed
Locator: getByText('e2e daily task')
Expected: visible
Timeout: 10000ms
Error: element(s) not found
```

The Page snapshot in the error-context shows only the `<h1>Routine Tasks</h1>` heading (the static HTML fallback), nothing else. The browser console (visible in `trace.zip`) contains:

```
"Executing inline script violates the following Content Security Policy directive 'script-src 'self''.
Either the 'unsafe-inline' keyword, a hash ('sha256-...'), or a nonce ('nonce-...') is required to enable inline execution. The action has been blocked."
```

Network log shows: HTML loaded, all Vite-served modules loaded (200), but **zero `/api/*` calls** after `page.reload()`. That's the smoking gun: React never reached the point of mounting and firing useEffects.

## Why the initial `/` works but reloads break

In `@cloudflare/vite-plugin@0.1.x`, `run_worker_first: true` (set in `wrangler.jsonc`) is honored only in production. In dev, the plugin serves `/` directly from Vite's static handling and **bypasses the Worker entirely**. So:

- `GET /` → Vite serves index.html → no Hono middleware → no CSP header → preamble runs → React mounts ✓
- `GET /spaces/<uuid>/tasks` (SPA fallback path) → Vite has no file there, falls through to the Worker → Hono middleware applies CSP → preamble blocked → React doesn't mount ✗
- `page.reload()` on `/spaces/<uuid>/tasks` → same as above ✗

Newer versions of `@cloudflare/vite-plugin` may honor `run_worker_first` in dev too. If yours does, the initial load also breaks, and you'll catch this trap immediately rather than only on reload. Either way, the fix is the same: don't run e2e against `vite dev`.

## Why "just relax CSP in dev" is wrong

Tempting to add `'unsafe-inline'` to your `securityHeadersMiddleware` when the request origin is localhost. Don't. Here's why:

1. **Dev/prod CSP divergence**: your e2e tests then pass against a CSP configuration that production doesn't use. The whole point of e2e is to catch regressions in the actual deployed configuration. Drift the dev config, lose the regression coverage.

2. **Permission creep**: `'unsafe-inline'` for dev becomes "well, just for this one quick fix" in prod. Once a `script-src 'unsafe-inline'` exists in your codebase, pressure to keep it there grows.

3. **The real fix is structurally simple**: target the build artifact for e2e instead of the dev server. The built `index.html` does not contain the HMR preamble (it's only injected by the dev plugin). So strict CSP works.

## The correct fix

Change Playwright's `webServer.command` from `pnpm dev` to a build + `wrangler dev` combo:

```typescript
// playwright.config.ts
webServer: {
  command: "pnpm run e2e:server",
  url: "http://localhost:5173",
  reuseExistingServer: true,
  timeout: 180_000,  // build + wrangler dev startup
},
```

```json
// package.json
"e2e:server": "pnpm build && pnpm exec wrangler dev --config dist/<bundle>/wrangler.json --persist-to .wrangler/state --port 5173"
```

The `--persist-to` is for Trap 2 (see `wrangler-state-path-quirk.md` in this skill). Don't omit it.

After the switch:
- Built HTML has no Vite HMR preamble → no inline script → CSP strict is satisfied
- Worker runs first (`run_worker_first` IS honored by `wrangler dev`, regardless of vite-plugin version) → all paths get the same Hono middleware → security headers test catches regressions everywhere
- e2e is testing production-equivalent wiring, not dev-mode plumbing

The cost: you lose HMR for tests (build runs every time you start the e2e server). But you don't iterate on tests with HMR — you iterate on app code with HMR via your separate `pnpm dev` terminal, then run `pnpm e2e` once at the end.

## How to detect this trap from the symptoms

| Symptom | Cause | Fix |
|---|---|---|
| `page.reload()` then assertion times out, no API calls in trace | CSP blocks HMR preamble, React doesn't remount | Switch e2e to build artifact |
| Initial load works, subsequent navigations break | Same — initial `/` bypasses Worker, others don't | Same |
| `Executing inline script violates ... 'script-src 'self''` in browser console | The trap, exactly | Same |
| security-headers test passes but auth tests fail | React works but DB layer is broken — different trap (state path) | See `wrangler-state-path-quirk.md` |
| All tests fail uniformly with no console output | Different problem entirely (server not starting) | Check `pnpm run e2e:server` output |

## Generalizable lesson

**Dev-mode plumbing optimizes for fast iteration, not production parity. E2e is exactly where parity matters.** Anywhere you have a "dev mode" that injects code, transforms responses, or bypasses middleware (Vite HMR, webpack-dev-server, Next.js dev mode, Storybook static, etc.), assume your e2e against that dev mode is testing a different thing than production. When the gap matters, point e2e at the production-equivalent build.

This generalizes beyond CSP. Examples of the same pattern:
- Webpack dev server's `eval-source-map` produces code that fails in production CSP
- Next.js dev mode injects `__next` globals not present in `next start`
- Vite's `import.meta.env` differs between dev and build (define-replace timing)

If you're debugging "works in dev, fails in prod", check whether your dev-mode tool is transforming responses. The transform itself is usually invisible.
