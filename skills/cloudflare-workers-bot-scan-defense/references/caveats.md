# Caveats — when the rate limit "doesn't work"

The number one source of confusion with Workers Rate Limiting: a synthetic burst test returns 200 for every single request, far past your configured `simple.limit`. Before you conclude the binding is broken, read this.

## What we observed in production

A real example from a deployment with `simple.limit: 30, simple.period: 60`:

| Test pattern | Total requests | 429 returned |
|---|---|---|
| Sequential 35 over ~35s (1 IP) | 35 | 0 |
| Parallel 60 (1 IP, single colo) | 60 | 0 |
| Parallel 80 (1 IP, single colo) | 80 | 0 |
| Sustained 10 rps × 12s (120 total) | 120 | 0 |
| **Total** | **295** | **0** |

The Worker bundle contained `c.env.AUTH_RATE_LIMITER.limit(...)` and `rate_limited` strings. `wrangler versions view` showed `env.AUTH_RATE_LIMITER (30 requests/60s)    Rate Limit`. Workers Observability showed the requests with `cpuTimeMs: 1`, all status 200. The middleware was running. The binding was registered. **The limiter just didn't reject.**

This is not a bug in the implementation. It matches the documented behavior.

## Why it happens — three documented reasons

### 1. Eventually consistent counters

From [the official docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/):

> Rate limiting bindings are eventually consistent, and may briefly allow more requests than the limit when many requests are made in a very short time period.

The counter propagates across nodes within a colo on a delay. Bursts faster than the propagation window slip through. This is by design — the alternative (strict consistency) would put a synchronization step in the request path, which is incompatible with Workers' performance contract.

### 2. Per-Cloudflare-location counters

From the same docs:

> Limit: the number of tokens allowed within a given period in a single Cloudflare location

Each Cloudflare data center maintains its own counter. From a single client IP, requests typically all hit the same colo (your nearest one), so this rarely matters in practice — but it does mean a coordinated attacker bouncing through multiple colos via Anycast quirks could see effectively `limit × N_colos` of headroom.

### 3. Lazy initialization on first deploy

Anecdotally (not in docs): the binding sometimes appears to take time after the first deploy to start enforcing reliably. **Wait at least 30 minutes after the initial deploy before drawing conclusions from a synthetic burst test** — this matches the runbook below. If you burst-test immediately after deploy, expect more passthrough than after the binding has been "warm".

## What this means for your defense strategy

### Don't rely on synthetic burst tests for verification

What you can verify reliably:

1. **Configuration**: `wrangler versions view <id>` shows the `Rate Limit` binding row
2. **Code path**: `grep` the bundle for `rate_limited` and your binding name
3. **Telemetry**: Workers Observability captures the route's invocations with `$metadata.trigger`

What you can't reliably verify with a 5-minute test:

- "If 100 bots hit me, 70 will get 429" — eventually true on average, but not in synthetic burst

### Treat Observability as the actual safety net

Even when the binding lets a burst through, the structured logs let you:

- Detect anomalies (`$metadata.trigger == "POST /api/auth/login/begin"` count spike)
- Correlate `rayId` to source IP for incident response
- Set up a Logpush-driven alert on burst conditions
- Add a periodic check (e.g., scheduled Worker cron) that queries last-hour invocations and pings Discord/Slack on anomalies

This is a stronger defense for the "I want to know when bots hit me" goal than the binding itself.

### When to escalate to Cloudflare WAF Rate Limiting Rules

If you genuinely need **strict** per-IP enforcement (not just CPU drain protection), use **Cloudflare Dashboard → Security → WAF → Rate limiting rules**. These run at the edge before reaching the Worker, are stricter, and are what enterprise customers use for production abuse cases.

Decision matrix:

| Goal | Use |
|---|---|
| "Bots shouldn't drain my Worker invocations" | Worker binding (this skill) |
| "Different limits for different user tiers" | Worker binding (key by user/plan, not IP) |
| "Block abusive IPs entirely from my origin" | WAF Rate Limiting Rule |
| "Don't even let DDoS reach my Worker" | WAF Rate Limiting Rule + Bot Fight Mode |
| "Differentiate human vs. bot at signup" | Turnstile / CAPTCHA, not rate limiting |
| "Fence off /admin from anyone outside my office IPs" | Cloudflare Access / IP firewall |

The Worker binding is for **decisions inside your Worker logic** ("did this request consume one of this user's tokens?"). The WAF rule is for **edge enforcement** ("this IP is blocked from your origin"). They're complementary, not redundant.

## The "rate limit didn't engage" runbook

When a synthetic test fails to produce 429s but the binding is correctly configured:

1. **Verify the three checks** from the main SKILL.md (`wrangler versions view`, bundle grep, Observability presence). If all three pass, **stop debugging the limiter** — it is configured correctly.

2. **Wait at least 30 minutes** after deploy and retest. Lazy initialization is a real factor.

3. **Tighten the limit** as a sanity check — if `limit: 5, period: 60` also doesn't engage, there's a real issue (binding misnamed, namespace_id colliding with something else, etc.). If `limit: 5` does engage but `limit: 30` doesn't, that's just eventual consistency — your bursts at the original threshold are too tight.

4. **Switch to a WAF Rate Limiting Rule** if you need strict enforcement and the eventually-consistent behavior isn't acceptable for your use case. The Worker binding stays in place as defense in depth.

5. **Don't over-engineer** — for a low-traffic family/internal app, "the binding is configured + Observability is on" is enough defense. Bots will hit your binding, occasionally slip through, and Observability will show you when something abnormal is happening. That's the operational target.

## Documented limits and version requirements

- Workers Rate Limiting bindings: GA on Free and Paid plans
- Wrangler version: **must be 4.36.0 or later** ([docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/))
- `simple.period`: **must be 10 or 60** seconds (other values fail config validation)
- `simple.limit`: positive integer, no documented upper bound for normal use
- `namespace_id`: positive integer as a string, account-unique
- Workers Observability sampling: `head_sampling_rate` between 0 and 1 (0 = disabled, 1 = 100%)

## Related Cloudflare features (don't confuse)

- **Workers Rate Limiting binding** (this skill) — in-Worker decision, eventually consistent
- **WAF Rate Limiting Rules** — edge enforcement, configured in Dashboard, stricter
- **Bot Fight Mode / Super Bot Fight Mode** — managed bot detection, Dashboard configuration
- **Turnstile** — Cloudflare's CAPTCHA replacement, for human/bot disambiguation at form submission
- **Cloudflare Access** — identity-based access control, replaces VPN/IP allowlist for internal apps
- **Workers Custom Limits** — per-script CPU/duration caps in `wrangler.jsonc` `limits.cpu_ms` (different concern: protect against runaway code, not rate limit traffic)
