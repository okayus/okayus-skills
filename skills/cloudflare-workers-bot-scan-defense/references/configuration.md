# Configuration

Full source for the three artefacts. Drop these in and adjust binding names / route paths.

## `wrangler.jsonc`

```jsonc
{
  "$schema": "./node_modules/wrangler/config-schema.json",
  "name": "your-worker",
  "main": "./worker/index.ts",
  "compatibility_date": "2025-03-28",

  "assets": {
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": true
  },

  // ⚠ Without this block, Workers Observability is empty for your script.
  // head_sampling_rate: 1 = log 100% of invocations. Drop to 0.1 / 0.01 for
  // high-traffic public apps to control logging cost.
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1
  },

  // Workers Rate Limiting binding. Each entry creates a separate counter.
  // - namespace_id: account-unique integer string (any number you pick)
  // - simple.period: must be 10 or 60 (other values fail config validation)
  // - simple.limit: tokens per period per Cloudflare location
  // Two bindings sharing namespace_id share counters across Workers.
  "ratelimits": [
    {
      "name": "AUTH_RATE_LIMITER",
      "namespace_id": "1001",
      "simple": {
        "limit": 30,
        "period": 60
      }
    }
  ],

  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "your-db",
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "drizzle"
    }
  ]
}
```

### Picking the limit

For a small app (family / internal / hobby): **30/60s** is comfortable. Real users rarely hit auth endpoints; bots that try will be capped quickly enough.

For a public app with legitimate signup volume: don't try to find one number that works for both real users and bots. Instead, **add a Turnstile / CAPTCHA gate** and set the rate limit looser (e.g., 300/60s) as a coarse abuse cap. Real protection comes from CAPTCHA; rate limit catches what gets through.

For a strictly-internal Worker with known IP set: skip rate limiting and use a Cloudflare Access / mTLS / IP-allowlist policy instead. Rate limiting is for "can't enumerate users in advance" cases.

### Why not multiple namespaces

You might be tempted to give every endpoint its own namespace ("login has its own counter, register has its own counter"). Don't, unless you have specific reasoning. One shared namespace for all unauthenticated CPU-spending routes keeps the math simple and makes it harder for attackers to amortize their burst across endpoints.

## TypeScript types

```ts
// worker/types.ts
import type { DisplayName, UserId } from "./domain/auth";

// Workflow / Ai / D1Database / R2Bucket / RateLimit are global types declared
// by @cloudflare/workers-types. No import needed in a worker tsconfig that
// has "types": ["@cloudflare/workers-types"].
export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  AUTH_RATE_LIMITER: RateLimit;
  // ... other bindings
  SESSION_SECRET: string;
};

type Variables = {
  userId: UserId;
  displayName: DisplayName;
};

export type Env = { Bindings: Bindings; Variables: Variables };
```

The `RateLimit` interface (from `@cloudflare/workers-types`) is approximately:

```ts
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
```

## The Hono middleware

```ts
// worker/middleware/rate-limit.ts
import { createMiddleware } from "hono/factory";
import type { Env } from "../types";

export const authRateLimit = createMiddleware<Env>(async (c, next) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.AUTH_RATE_LIMITER.limit({ key: ip });
  if (!success) {
    return c.json({ error: { type: "rate_limited", message: "Too many requests" } }, 429);
  }
  await next();
});
```

### Why hard-coded vs. parameterised

You might be tempted to write a generic factory:

```ts
// ❌ Don't do this without a reason
export function rateLimit(bindingKey: keyof Bindings) { ... }
```

This adds type gymnastics (the binding key needs a conditional-typed filter) for zero practical benefit when you have one rate-limiter binding. Re-read [the Cloudflare Rate Limiting docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) before adding a second binding — most apps need exactly one.

If you genuinely need multiple limiters (e.g., a separate one for an unauthenticated public webhook), export a second middleware:

```ts
export const webhookRateLimit = createMiddleware<Env>(async (c, next) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const { success } = await c.env.WEBHOOK_RATE_LIMITER.limit({ key: ip });
  // ...
});
```

### Why `CF-Connecting-IP` and not `cf-ip` / `x-forwarded-for`

`CF-Connecting-IP` is the only header Cloudflare *guarantees* to set with the originating client IP, regardless of upstream proxies. `X-Forwarded-For` may be present but **untrusted** (clients can set it). `True-Client-IP` is also available but is an enterprise-tier feature.

If `CF-Connecting-IP` is somehow missing (would be unusual on Cloudflare-served traffic), the fallback `"unknown"` collapses all such requests to one bucket — that's acceptable failsafe behavior because it caps the unknown-IP traffic at the same limit as a single client.

## Wiring into routes

```ts
// worker/routes/auth.ts
import { Hono } from "hono";
import { authRateLimit } from "../middleware/rate-limit";
import { sessionMiddleware } from "../middleware/session";
import type { Env } from "../types";

export const authRoutes = new Hono<Env>()
  // ⬇ Apply only to unauthenticated POST endpoints that do CPU work
  .post("/register/begin", authRateLimit, async (c) => { /* ... */ })
  .post("/register/verify", authRateLimit, async (c) => { /* ... */ })
  .post("/login/begin", authRateLimit, async (c) => { /* ... */ })
  .post("/login/verify", authRateLimit, async (c) => { /* ... */ })

  // ⬇ Authenticated routes: sessionMiddleware already gates these. No rate limit.
  //   Don't rate-limit logged-in users; you'll knock yourself offline.
  .post("/logout", sessionMiddleware(), async (c) => { /* ... */ })
  .get("/me", sessionMiddleware(), async (c) => { /* ... */ })
  .get("/credentials", sessionMiddleware(), async (c) => { /* ... */ });
```

## Integration with existing security headers

If you already use `hono/secure-headers` (HSTS, CSP, X-Frame-Options), the rate-limit middleware composes cleanly — the order in `index.ts` doesn't matter for these two:

```ts
const app = new Hono<Env>();
app.use("*", secureHeaders({ /* ... */ }));   // applies to all responses
app.onError(/* ... */);
app.route("/api/auth", authRoutes);            // rate-limit applied per-route
```

429 responses will still get the security headers (good — they should).

## Tests for the boundary

Per the testing philosophy of "unit = meaning, e2e = wiring", the rate-limit middleware does not warrant a unit test — it's pure boundary I/O. The behavior you actually want to verify is "the binding is configured and the middleware is in the bundle", which the verification flow in the main SKILL.md covers via:

1. `wrangler versions view` showing the binding
2. `grep` of the production bundle for `rate_limited`
3. Workers Observability showing the trigger

A unit test of the middleware would just verify `c.json(..., 429)` gets called when the mocked binding returns `{success: false}` — that's tautological.

If you really want a regression test, an e2e burst test against a dev server is more useful than a mocked unit test, but **see [caveats.md](caveats.md) for why synthetic bursts often look like the limiter is broken** even when it's correctly wired.
