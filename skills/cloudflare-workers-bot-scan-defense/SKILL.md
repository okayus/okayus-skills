---
name: cloudflare-workers-bot-scan-defense
description: Make a Cloudflare Workers app resilient to bot scans that arrive within minutes of HTTPS publication via CT Log enumeration. Use when deploying a new Worker (especially with auth or paid bindings), when budget/cost is a concern, or when you want to detect "/.env" / "/admin" / "/wp-login.php" / "/.git/config" probing. Covers the mental model (CT Log → bot scan → which paths actually cost you money), the edge-cache absorption that makes most scans free, the narrow set of unauthenticated routes that do need rate limiting (auth `begin`/`verify`), the exact `wrangler.jsonc` `observability` + `ratelimits` config (plus the wrangler 3.x `unsafe.bindings` fallback for projects still on v3), the IP-keyed Hono middleware pattern (with the fail-open variant), the verification flow via `wrangler versions view` + Workers Observability — including the trap that v3's `versions view` renders neither the `unsafe` ratelimit binding nor `observability`, and a credential-free verification path for sandboxed agents / keyless CI — and the documented eventual-consistency caveat that makes synthetic burst tests look like the limiter is broken.
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets Cloudflare Workers (Free or Paid) with `@cloudflare/workers-types@4.20240000+`, `wrangler@^4.36.0` (the top-level `ratelimits` key), Hono / D1 / R2 stacks, and either `*.workers.dev` or a custom domain. Projects still on **wrangler 3.x** can use the `unsafe.bindings` fallback in "Add a Workers Rate Limit binding" below. Workers Rate Limiting binding is GA on both Free and Paid; Workers Observability requires enabling per-Worker via `wrangler.jsonc`.
metadata:
  author: okayus
  version: "0.2.0"
---

# Cloudflare Workers Bot Scan Defense

The day you point HTTPS at a domain — even a `*.workers.dev` subdomain you haven't told anyone about — your hostname appears in [Certificate Transparency Logs](https://certificate.transparency.dev/), and within minutes scanner bots start probing `/.env`, `/.git/config`, `/admin`, `/wp-login.php`, `/index.php.bak`, `/.DS_Store`, and dozens more. Family-only apps get scanned. Staging gets scanned. Internal tools get scanned. Even sites with no UI link anywhere get scanned.

The bots are cheap to run and free to scale, so they don't care if you're a Fortune 500 or a hobby project — they just throw the wordlist and harvest whatever responds.

This skill captures the mental model, the small set of changes that actually matter on Cloudflare Workers, and the verification flow.

## When to use this skill

- Deploying a Worker that will be reachable on HTTPS (with `*.workers.dev` or custom domain) — even if the URL is private
- The Worker has **unauthenticated routes that do CPU work** (auth `begin`/`verify`, magic-link issuance, signup, captcha, public webhooks)
- Cost is a concern: paid plan with Workers AI / D1 reads / outbound subrequests, or you're near a free-tier ceiling
- You don't currently have observability — i.e., you couldn't answer "how many bot probes hit my Worker last night?" right now
- Auditing an existing Worker's exposed surface to decide what to harden first

The exclusions below apply specifically to the **rate-limit binding + middleware** portion of this skill. **Workers Observability (the first artefact in "The minimum viable defense" below) is universally beneficial and should still be enabled even in the cases listed here** — it costs nothing and gives you visibility regardless of how requests are gated.

Do **not** apply the rate-limit binding portion for:
- A Worker that returns hard 401/403 with no DB hit on every unauthenticated route (you're already fine — bots can't drain you)
- A Worker fronted by Cloudflare Access / IP allowlist where every route is already gated above the Worker layer (Access returns 302/403 before the Worker is invoked, so there's nothing left to rate-limit). **Caveat**: a custom domain protected by Access does *not* automatically protect the `<worker-name>.<account>.workers.dev` URL — that endpoint stays open by default and bypasses your Access policy. Set `workers_dev: false` in `wrangler.jsonc` to close it (recommended), or attach a separate Access application targeting the `*.workers.dev` hostname (Dashboard → Zero Trust → Access → Applications → Add → Self-hosted, with the workers.dev hostname). Verify with `curl -I https://<worker-name>.<account>.workers.dev/` after deploy — expect a 302 redirect or 403.
- DDoS-grade attacks (you need WAF / Cloudflare Pro+ rules, not just a Worker binding)
- Application-level brute force (e.g., trying credentials against a known username) — that's `auth-brute-force` territory and needs per-account lockout, not just per-IP rate limit

## The mental model — what bots actually drain

Most bot scans target paths that **don't exist** in your app: `/.env`, `/.git/config`, `/wp-admin/`, etc. On a Cloudflare Workers + SPA setup with `not_found_handling: "single-page-application"`, those paths fall through to the SPA fallback (`index.html`). **After the first Worker invocation for each unique URL, the Cloudflare edge caches the response and serves subsequent requests with `cf-cache-status: HIT` — the Worker is not re-invoked.** Bot scanners hammer the same wordlist URLs, so the long tail is absorbed by edge cache; only the first request per unique path costs you a Worker invocation. D1 isn't touched (the SPA fallback path doesn't touch DB). CPU billing for the cached path stops. **You're already fine for the wordlist 99% of the time.**

This holds regardless of `run_worker_first: true|false`. With `run_worker_first: true`, the first request per path invokes the Worker, which falls through to `c.env.ASSETS.fetch(c.req.raw)` for unknown paths; the response is cacheable and the edge memoizes it. With `run_worker_first: false`, the asset binding serves directly without Worker invocation. Either way, repeat scans hit cache.

What's actually expensive is the small set of **unauthenticated routes that do real work**:

| Route | Cost per call | Bot drain risk |
|---|---|---|
| `POST /api/auth/login/begin` (WebAuthn challenge) | crypto + JWT sign + cookie | **High** — challenge generation is CPU |
| `POST /api/auth/register/begin` | DB read + crypto | **High** if registration is open |
| `POST /api/auth/login/verify` | DB read + crypto | High — D1 read fires before validation can short-circuit |
| `GET /health` | constant body | Low — cheap and harmless |
| `/api/*` with session middleware | nothing if no cookie (just 401) | **Low** — no D1 touch on missing cookie |

The defense you actually need is a small one: **observability everywhere, rate limit on the 3-5 routes that do CPU work pre-auth**. Don't bother adding rate limit to every `/api/*` endpoint — `sessionMiddleware` + missing cookie already returns 401 in microseconds without a DB hit.

## Audit your attack surface in 2 minutes

Before you change anything, probe what's actually exposed. The output tells you which paths are edge-cached (free) vs. which paths reach the Worker (potentially expensive).

```bash
BASE=https://your-app.example.workers.dev

for path in "/" "/.env" "/.git/config" "/admin" "/wp-login.php" "/.DS_Store" \
            "/api" "/api/cats" "/api/auth/me" "/api/auth/login/begin" "/health" "/robots.txt"; do
  printf '%-25s ' "$path"
  curl -skI --max-time 8 "$BASE$path" \
    | grep -iE '^(HTTP/|cf-cache-status|content-type)' \
    | tr '\n' ' '
  echo
done
```

What to look for:

- **`cf-cache-status: HIT` on bogus paths** (`/.env`, `/admin`, ...) → edge is absorbing them, no Worker invocation. **You don't need to do anything for these.**
- **`HTTP/2 401` on `/api/*` with `application/json`** → session middleware is short-circuiting, good. Verify no DB query happens (read `worker/middleware/session.ts`).
- **`HTTP/2 200` on a public unauthenticated POST endpoint** (e.g., `/api/auth/login/begin`) → this is your protect-with-rate-limit target.
- **`HTTP/2 500` on anything random** → suspicious. The `app.onError` handler should return a generic `{error:{type:"internal"}}` 500 — never a stack trace. Fix this before adding rate limit.

Full probing recipe in [references/attack-surface-audit.md](references/attack-surface-audit.md).

## The minimum viable defense

Three artefacts. None requires a paid plan.

### 1. Enable Workers Observability

Add to `wrangler.jsonc`:

```jsonc
{
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1
  }
}
```

`head_sampling_rate: 1` = 100%. For a low-traffic family/internal app this is fine; for a high-traffic public app drop to `0.1` or `0.01` to control cost. Without this block the Workers Observability dataset is **empty for your script** — you literally cannot see scan traffic.

### 2. Add a Workers Rate Limit binding

```jsonc
{
  "ratelimits": [
    {
      "name": "AUTH_RATE_LIMITER",
      "namespace_id": "1001",
      "simple": {
        "limit": 30,
        "period": 60
      }
    }
  ]
}
```

`namespace_id` is an account-unique integer string (any number you pick). `simple.period` **must be 10 or 60** — other values fail config validation. Two bindings sharing the same `namespace_id` share counters, which is intentional if you want "one rate limit across multiple Workers".

#### Wrangler 3.x fallback (no top-level `ratelimits` key)

The top-level `ratelimits` key above requires **wrangler 4.36.0+**. On a project still on **wrangler 3.x**, that key is rejected — but the same binding is available through the `unsafe.bindings` escape hatch with `type: "ratelimit"`. The runtime binding is identical (`env.AUTH_RATE_LIMITER.limit(...)`); only the config shape differs:

```jsonc
{
  // wrangler 3.x: top-level `ratelimits` is unsupported — use the unsafe form.
  "unsafe": {
    "bindings": [
      {
        "name": "AUTH_RATE_LIMITER",
        "type": "ratelimit",
        "namespace_id": "1001",
        "simple": { "limit": 30, "period": 60 }
      }
    ]
  }
}
```

This is verified working on `wrangler@3.114.x`. Note the cost: `unsafe` bindings are **not validated** by wrangler at config-parse time, and (see "Verify after deploy") wrangler 3.x's `versions view` does **not** render them — so a typo here fails silently. Prefer upgrading to 4.36+ and the top-level form when you can; use this only when the upgrade is out of scope. Pair it with the **fail-open middleware** (below) so a missing/misnamed binding degrades to "no rate limit" rather than locking every user out.

`RateLimit` is a **global type** from `@cloudflare/workers-types` — no import needed in a worker tsconfig. Add it to your Bindings:

```ts
type Bindings = {
  AUTH_RATE_LIMITER: RateLimit;
  // ... other bindings
};
```

### 3. Apply per-route in Hono via middleware

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

// worker/routes/auth.ts — apply only to the unauthenticated CPU-spending routes
export const authRoutes = new Hono<Env>()
  .post("/register/begin", authRateLimit, async (c) => { /* ... */ })
  .post("/register/verify", authRateLimit, async (c) => { /* ... */ })
  .post("/login/begin", authRateLimit, async (c) => { /* ... */ })
  .post("/login/verify", authRateLimit, async (c) => { /* ... */ });
```

Don't apply it to authenticated routes — `sessionMiddleware` already gates those, and rate-limiting authenticated requests adds a fragile failure mode where one busy family member knocks themselves offline.

**Fail-open variant.** The snippet above assumes the binding always exists; in local dev (where you don't provision the binding) or if the binding is ever absent/misnamed, `c.env.AUTH_RATE_LIMITER` is `undefined` and `.limit()` throws — turning a limiter hiccup into a login outage. Guard on the binding so it degrades to "no limit" instead. This also makes the behavioral burst test interpretable (see "Verify after deploy"): with fail-open, a 429 can *only* come from a live binding, so a 429-when-seen is positive proof it's wired.

```ts
export const authRateLimit = createMiddleware<Env>(async (c, next) => {
  const limiter = c.env.AUTH_RATE_LIMITER;
  if (limiter) {                                   // fail OPEN if absent
    const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
    const { success } = await limiter.limit({ key: ip });
    if (!success) return c.json({ error: { type: "rate_limited" } }, 429);
  }
  await next();
});
```

Full implementation walkthrough in [references/configuration.md](references/configuration.md).

## Verify after deploy

Three checks, in order:

```bash
# 1. The binding appears in the deployed worker's binding list
pnpm exec wrangler versions view <version-id> --name <worker-name> | grep -E 'Rate Limit|Observability'
# Expected (wrangler 4.36+): env.AUTH_RATE_LIMITER (30 requests/60s)    Rate Limit
```

> ⚠ **Wrangler 3.x renders neither `unsafe` ratelimit bindings nor `observability` in `versions view`.** On v3 the output lists only D1/KV/vars/secrets, so this check shows **nothing for the rate limiter even when it is correctly deployed** — a false negative, not a missing binding. (Run `wrangler versions view <id>` and you'll see the bindings section stop at `d1_databases`.) On v3, confirm via the **Dashboard** instead — Workers & Pages → `<worker>` → Settings → Bindings shows `AUTH_RATE_LIMITER`, and the Observability tab shows whether observability is on — or use the credential-free path below. This is the verification flow the `unsafe` fallback breaks; budget for it if you can't upgrade to 4.36+.

```bash
# 2. Observability captures the route as a $metadata.trigger
# Cloudflare Dashboard → Workers → <name> → Observability → filter $metadata.trigger
# Expected: "POST /api/auth/login/begin" shows up within 5-10 minutes of first traffic
```

```bash
# 3. The rate limit binding name string is in the bundle
grep -c "AUTH_RATE_LIMITER\|rate_limited" dist/<your-worker>/index.js
# Expected: > 0 (your middleware compiled into the bundle)
```

If 1 + 2 + 3 all pass, you're correctly configured **even if the next step (synthetic burst test) doesn't return 429**. See the next section.

### Verifying without Cloudflare credentials (sandboxed agents / keyless CI)

Checks 1 and 2 above need an authenticated Cloudflare session (`wrangler versions view`, the Dashboard). If your deploy pipeline is *keyless* — e.g. Cloudflare Workers Builds plus a sandboxed agent that deliberately holds **no** Cloudflare credential — you cannot run them, and that's by design, not a gap to paper over: reading deployed account state is exactly the operation the credential boundary exists to gate. The blocker is the absent credential, **not** egress (a locked-down sandbox can still reach `api.cloudflare.com` and your prod host if they're allowlisted). Verify these ways instead, no credential required:

- **Source + pipeline truth.** The deployed config *is* `wrangler.jsonc` in the merged branch, built by your git-connected CI. Read the `observability` / `ratelimits` (or `unsafe.bindings`) block and the consuming middleware, then confirm the build is green over unauthenticated GitHub REST: `curl -s https://api.github.com/repos/<owner>/<repo>/commits/<branch>/check-runs` and look for your build check `conclusion: success`. Config-in-VCS + green keyless build ⇒ deployed.
- **Behavioral black-box for the rate limiter.** Burst the protected route from one IP and watch for `429`: `for i in $(seq 1 40); do curl -s -o /dev/null -w '%{http_code}\n' https://<host>/<protected-route>; done | sort | uniq -c`. **A 429 is positive proof the binding is live and enforcing** — decisive with the fail-open middleware (no binding ⇒ it can never 429). The converse does *not* hold: **no 429 is inconclusive**, because Workers Rate Limiting is eventually consistent and per-colo (see "The synthetic burst test caveat"). So treat 429-seen as a green check and absence as "unknown, fall back to source+pipeline".
- **Observability is not externally observable.** Whether `observability.enabled` is live can't be probed from outside — no black-box signal exists. Confirm it from `wrangler.jsonc` + a green build, or accept that the live on/off state needs the Dashboard / an authenticated session (host-side).

The takeaway: the *goal* ("did rate-limit + observability ship?") is almost entirely answerable credential-free; only the live-state reads that genuinely require an account session stay on the authenticated side.

## The synthetic burst test caveat (read this before debugging)

Workers Rate Limiting is **eventually consistent and per-Cloudflare-location**, both documented behaviors. Concretely: a script that fires 80 parallel `curl`s against `/api/auth/login/begin` from one machine **may see all 200s even though the limit is 30/60s**. This is not a bug in your code or config — it's the documented design.

Possible reasons your synthetic test "fails":

1. **Eventual consistency** — the counter takes time to propagate across the colo's nodes. Bursts faster than the propagation window slip through.
2. **Per-colo counters** — `simple.limit` is per Cloudflare data center; requests from a single client typically all hit one colo, but corner cases exist.
3. **Lazy initialization on first deploy** — the binding may take a few minutes after first use to start enforcing reliably.

What this means in practice:

- **Don't conclude the limiter is broken from a synthetic test.** Verify via the three checks above and let it sit for 30+ minutes before retesting.
- **For tighter enforcement, use Cloudflare WAF Rate Limiting Rules** (configured in Dashboard → Security → WAF → Rate limiting rules). These run earlier in the request path and are stricter. The Worker binding is for in-Worker decisions (e.g., different limits for different user tiers); the WAF rule is for "fence off this IP from my Worker entirely".
- **Treat Observability as the actual safety net.** Even when the binding lets a burst through, the structured logs show you the path, the rayId, and the trigger — you can write a Logpush-driven alert or a periodic check to spot anomalies.

Full caveat list and decision matrix (binding vs. WAF rule) in [references/caveats.md](references/caveats.md).

## What this skill does NOT cover

- **DDoS protection** — that's Cloudflare WAF / Pro+ / managed rules, not Worker binding. If you're under sustained attack, escalate to WAF.
- **Per-account brute force lockout** — login throttling by username/account, not by IP. Different design (you need a `failed_login_attempts` table + cooldown), and `auth-brute-force` skills cover that.
- **Captcha / Turnstile integration** — orthogonal layer above rate limiting, useful for signup endpoints and webhooks but not covered here.
- **Custom WAF Rate Limiting Rules** — Dashboard configuration, not `wrangler.jsonc`. Cross-references this skill but is its own setup flow.
- **Bot Fight Mode / Super Bot Fight Mode** — Cloudflare's managed bot detection, configurable in Dashboard. Useful in tandem with this skill but not part of the deliverable.
- **CT Log monitoring** — you cannot opt out of CT Log unless you accept browser warnings. Internal-only deployments can use private CAs, but that's a different track.

## References

- [attack-surface-audit.md](references/attack-surface-audit.md) — the full `curl` probe script with example outputs, how to read `cf-cache-status` HIT/MISS/DYNAMIC for SPA fallback paths, and what to do when a path you thought was a 404 returns 200
- [configuration.md](references/configuration.md) — full `wrangler.jsonc` snippet with all knobs explained (`namespace_id`, `simple.limit`, `simple.period`, `head_sampling_rate`), the Hono middleware pattern with TypeScript types, and how to wire it into `worker/routes/auth.ts` without affecting authenticated routes
- [caveats.md](references/caveats.md) — the eventual-consistency / per-colo / lazy-init notes with citations to Cloudflare docs, the binding-vs-WAF-rule decision matrix, the "rate limit didn't engage in synthetic burst" runbook, and how to escalate to a WAF Rate Limiting Rule if you genuinely need strict enforcement
- [Cloudflare Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) — official docs (note the "Must use Wrangler 4.36.0+" requirement)
- [Workers Observability](https://developers.cloudflare.com/workers/observability/) — official docs for the dataset schema and Dashboard
- [Why CT Log scanning happens (Zenn, JP)](https://zenn.dev/kusuke/articles/25330f7759eba4) — the article that triggered this skill
