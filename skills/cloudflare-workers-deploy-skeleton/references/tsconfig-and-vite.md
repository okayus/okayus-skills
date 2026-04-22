# TypeScript + Vite configuration

Strict-mode TypeScript with the `@cloudflare/vite-plugin` wiring that lets `vite dev` simulate both the SPA and the Worker.

## `packages/web/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": false,
    "noEmit": true,
    "types": ["@cloudflare/workers-types", "vite/client"]
  },
  "include": ["src/**/*", "worker/**/*", "vite.config.ts"]
}
```

### Notable settings

- **`strict: true`** + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noImplicitOverride` — catches a wide class of bugs at compile time. Don't relax these without a specific reason
- **`types: ["@cloudflare/workers-types", "vite/client"]`** — Workers types give you `D1Database`, `Fetcher`, `ScheduledController`, etc. `vite/client` gives `import.meta.env`
- **`include: worker/**/*`** — covers `worker/index.ts`, `cron.ts`, `types.ts` so the Worker is type-checked together with the SPA
- **Don't include `drizzle.config.ts`** in `include` yet. You don't have Drizzle installed. Adding it creates a dangling reference

## `packages/web/vite.config.ts`

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import cloudflare from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    react(),
    cloudflare({
      configPath: "./wrangler.jsonc",
    }),
  ],
  server: {
    port: 5173,
  },
});
```

### What `@cloudflare/vite-plugin` does in dev

- Reads `wrangler.jsonc` and spins up a **workerd** instance that runs your Worker code
- Routes incoming dev-server requests to the Worker first (because of `run_worker_first: true`), then falls back to Vite's SPA serving if the Worker doesn't handle the path
- Serves `.dev.vars` as `env` bindings
- Makes `c.env.DB` and `c.env.ASSETS` work in dev

### Version caveat

- `@cloudflare/vite-plugin@0.1.x` is the baseline matching `wrangler@^3.x`
- It has a known issue: `/__scheduled?cron=<expr>` for local Cron testing is not routed — it falls back to SPA HTML
- `1.x` fixes that but requires `wrangler@^4`. Bumping both together is a choice to defer until you actually need local Cron testing (see the `cloudflare-cron-to-discord` skill for fallback techniques)

## Dev test

After installing and setting up `.dev.vars` (see [dev-vars.md](dev-vars.md)):

```bash
pnpm dev
# Port 5173 starts; look for "Local: http://localhost:5173/"

# In another terminal:
curl -s http://localhost:5173/health   # → {"status":"ok"}
curl -s http://localhost:5173/ | grep -o '<h1>.*</h1>'  # → <h1>...</h1>
```

If `/health` 200 but `/` 404, jump to [spa-routing-diagnosis.md](spa-routing-diagnosis.md).
