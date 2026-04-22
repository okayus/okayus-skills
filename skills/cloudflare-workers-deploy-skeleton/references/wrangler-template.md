# wrangler.jsonc + packages/web/package.json templates

## `packages/web/package.json`

```json
{
  "name": "@<scope>/web",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "deploy": "pnpm build && wrangler deploy",
    "check": "tsc --noEmit",
    "db:migrate": "wrangler d1 migrations apply <db-name> --local",
    "db:migrate:prod": "wrangler d1 migrations apply <db-name> --remote"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@cloudflare/vite-plugin": "^0.1.0",
    "@cloudflare/workers-types": "^4.20250328.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0",
    "wrangler": "^3.100.0"
  }
}
```

Version pinning notes:
- `@cloudflare/vite-plugin` 0.1.x is the baseline that matches `wrangler@^3.x`. See the sibling `cloudflare-cron-to-discord` skill for the tradeoffs of bumping to 1.x (requires `wrangler@^4`, fixes `/__scheduled` dev behavior)
- **Don't add `drizzle-kit` / `drizzle-orm` yet.** The empty `0000_init.sql` validates the migration pipeline without an ORM dependency. Defer ORM until you have a schema to generate

## `packages/web/wrangler.jsonc`

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "<project-name>",
  "compatibility_date": "2025-03-28",
  "main": "./worker/index.ts",
  "assets": {
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": true
  },
  "vars": {
    // Initially localhost; Phase 4 (setup-order.md) overwrites to the real production hostname.
    // Once locked to production, NEVER change RP_ID — it invalidates every WebAuthn credential.
    "RP_ID": "localhost",
    "ORIGIN": "http://localhost:5173"
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "<db-name>",
      "database_id": "<REAL-UUID-FROM-wrangler-d1-create>",
      "migrations_dir": "drizzle"
    }
  ],
  "triggers": {
    "crons": ["0 * * * *"]
  }
}
```

**Substitute the `<...>` placeholders with real values immediately on file creation.** Do not commit a placeholder-bearing `wrangler.jsonc`.

Verify no placeholders remain:

```bash
grep -E '<[^>]+>' packages/web/wrangler.jsonc
# → expect zero lines of output
```

## Key settings explained

### `assets.not_found_handling: "single-page-application"` (L1)

When Assets can't find a file matching the request path, serve `index.html` instead. Required for client-side SPA routing.

### `assets.run_worker_first: true` (L2)

Every request hits the Worker before Assets. Lets you later wrap SPA HTML with `secureHeaders` middleware (CSP, HSTS, etc.). Without this, SPA HTML is served by Assets and Worker middleware never sees it.

### `triggers.crons: ["0 * * * *"]`

Fires every hour at minute 0 UTC. Adjust to taste — `15 * * * *` (minute 15) is a common choice to avoid clustered events at minute 0. See Cron schedule syntax in [Cloudflare docs](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

### `d1_databases[0].migrations_dir: "drizzle"`

Where `wrangler d1 migrations apply` looks for SQL files. Filename pattern: `0000_name.sql`, `0001_name.sql`, ... lexicographic order.
