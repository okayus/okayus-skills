# Worker-side templates: `worker/index.ts` / `cron.ts` / `types.ts`

Minimal Hono-based Worker with `fetch` + `scheduled` handlers and SPA delegation. Single-source `Bindings` in `types.ts`.

## `worker/types.ts`

```ts
export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  RP_ID: string;
  ORIGIN: string;
  // Add more bindings (secrets, KV, etc.) as needed. Every other worker file imports from here — don't re-declare the type.
};
```

**Single-source rule**: `worker/index.ts` and `worker/cron.ts` both `import type { Bindings } from "./types"`. Never define `type Bindings` inline in those files.

## `worker/index.ts`

```ts
import { Hono } from "hono";
import { runScheduled } from "./cron";
import type { Bindings } from "./types";

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => c.json({ status: "ok" }));

// L3 of the 3-layer SPA routing dance: delegate unmatched routes to the Assets binding.
app.notFound(async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  return new Response(res.body, res);
});

export default {
  fetch: app.fetch,
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScheduled(event, env));
  },
} satisfies ExportedHandler<Bindings>;
```

### Why `app.notFound` with `ASSETS.fetch`

With `run_worker_first: true` (L2), every request enters the Worker. For paths Hono doesn't route (SPA paths like `/about`), we need an explicit delegate-back-to-Assets step — that's L3. Without it, Hono would return its default 404.

Copying `res.body` into a new `Response` is defensive: it reuses the Assets response's headers and status but constructs a new object that won't be mutated by Hono's downstream handling.

### `scheduled` handler

Keep it thin. Delegate to `runScheduled` in `cron.ts` and wrap with `ctx.waitUntil` so the Worker isolate stays alive until the promise settles.

## `worker/cron.ts` (stub)

```ts
import type { Bindings } from "./types";

export async function runScheduled(
  event: ScheduledController,
  env: Bindings,
): Promise<void> {
  console.log("[cron] fired at", new Date(event.scheduledTime).toISOString());
  // Implement Cron logic in a later phase (see the cloudflare-cron-to-discord skill).
}
```

Leaving this as a log-only stub in the skeleton is intentional:
- Gives you proof the Cron registration works (visible in `wrangler tail`)
- No external dependency (Discord Webhook URL, etc.) needed yet
- Replace the body in a later phase when you know what you want to notify

## `packages/web/src/{main,App}.tsx`

Minimal React entry — any `<h1>` in `App` suffices to satisfy completion criterion 2.

```tsx
// src/App.tsx
export function App() {
  return <h1>My Project</h1>;
}

// src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

## `packages/web/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>My Project</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

That's the entire SPA entry for skeleton purposes. Real UI comes later.
