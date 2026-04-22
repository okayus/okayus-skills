# Diagnosing `/` returns 404

**Symptom**: `curl /health` returns 200 (so the Worker is running), but `curl /` returns 404 instead of SPA HTML.

SPA serving depends on **three layers agreeing**. If any one is missing, `/` 404s. Diagnose top to bottom:

## Layer check

| Layer | Location | Expected setting | Verify command |
|---|---|---|---|
| L1: Assets fallback | `wrangler.jsonc` | `"not_found_handling": "single-page-application"` | `grep not_found_handling packages/web/wrangler.jsonc` |
| L2: Worker runs first | `wrangler.jsonc` | `"run_worker_first": true` | `grep run_worker_first packages/web/wrangler.jsonc` |
| L3: Worker delegates to Assets | `worker/index.ts` | `app.notFound(async (c) => new Response((await c.env.ASSETS.fetch(c.req.raw)).body, ...))` | `grep -A 3 'app.notFound' packages/web/worker/index.ts` |

If any `grep` returns empty, that layer is missing. Restore it from `wrangler-template.md` or `worker-template.md`.

## Decision tree

```
curl /health → 200 ?
 ├─ NO → Worker itself isn't starting. Check vite dev output for errors.
 │       Typical: TypeScript error, missing binding, malformed wrangler.jsonc.
 └─ YES → Worker is up, problem is SPA serving.
    │
    curl / → 200 ?
    ├─ YES → Not a routing issue. Check the response body.
    └─ NO → Step through the 3 layers:
       │
       grep not_found_handling wrangler.jsonc
       ├─ Missing → Add L1 per wrangler-template.md
       └─ Present →
          grep run_worker_first wrangler.jsonc
          ├─ Missing → Add L2 per wrangler-template.md
          └─ Present →
             grep app.notFound worker/index.ts
             ├─ Missing → Add L3 per worker-template.md
             └─ Present → All 3 layers configured. See "If all 3 layers are present"
```

## If all 3 layers are present but `/` still 404s

### Most likely: `@cloudflare/vite-plugin` version issue

The plugin's dev simulation has evolved. Older versions may not implement the SPA fallback correctly.

```bash
pnpm --filter @<scope>/web update @cloudflare/vite-plugin
# Kill and restart `pnpm dev`
```

If updating moves you to 1.x, note that it requires `wrangler@^4`. Decide whether to bump wrangler simultaneously.

### In production only: build artifact issue

If the problem is **only in production** (local dev works):

```bash
pnpm --filter @<scope>/web build
ls packages/web/dist/index.html
# Expected: file exists. Check its <h1> content matches.
```

If `dist/index.html` doesn't exist, the build failed silently. Look at `vite build` output.

If it exists but has weird content, check `vite.config.ts` and the React entry files.

### In dev only: look at Vite's response

```bash
curl -si http://localhost:5173/
```

Look at the response body. If it's:
- HTML with a React dev refresh script → SPA is being served by Vite, but Hono thinks it's a 404. Probably Hono is returning a plain-text 404 and not hitting `app.notFound`. Add a Hono 404 log:
  ```ts
  app.notFound((c) => {
    console.log("[notFound] path:", c.req.path);
    return ...;
  });
  ```
- Completely empty → Vite dev server problem. Check `vite dev` console for errors
- `<!DOCTYPE html>` but wrong content → Vite is serving something, but not `index.html`. Check that `packages/web/index.html` exists

## Sanity check before deep diving

Make sure you're hitting the right server. If you have multiple dev servers running:

```bash
ss -lnt | grep -E "5173|8787"
# 5173 = Vite, 8787 = wrangler dev
```

If both exist, you may be talking to the wrong one. Kill the one you don't want.

## What this diagnosis doesn't cover

This playbook is for "SPA routing broken". Not covered:
- Cron handler not firing — see the `cloudflare-cron-to-discord` skill
- Authentication 401s — later phase, different skill
- D1 errors — probably the `database_id` isn't the right UUID or migrations didn't apply
