# Attack Surface Audit

The 2-minute probe that tells you which paths actually cost you money.

## Why probe before changing anything

Before you start adding bindings and middleware, you need to know which paths reach the Worker and which paths the Cloudflare edge is already absorbing. The naive assumption — "every bot scan costs me a Worker invocation" — is usually wrong on a SPA-fallback configuration: the edge serves the cached `index.html` and the Worker doesn't run.

Without this measurement step, you'll over-defend (rate-limiting routes the edge already handles) and under-defend (missing the small set of routes that actually do CPU work). Run the probe first, design the defense around the result.

## The probe script

```bash
BASE=https://your-app.example.workers.dev

for path in "/" "/.env" "/.env.local" "/.git/config" "/.git/HEAD" \
            "/admin" "/wp-admin/" "/wp-login.php" "/index.php.bak" \
            "/.DS_Store" "/.htaccess" "/server-status" "/.well-known/security.txt" \
            "/api" "/api/" "/api/cats" "/api/auth/me" "/api/auth/login/begin" \
            "/health" "/robots.txt" "/sitemap.xml" "/manifest.json"; do
  printf '%-30s ' "$path"
  curl -skI --max-time 8 "$BASE$path" \
    | grep -iE '^(HTTP/|cf-cache-status|content-type|cache-control)' \
    | tr '\n' ' '
  echo
done
```

For POST endpoints (those `begin`/`verify` routes), follow up with:

```bash
URL=https://your-app.example.workers.dev/api/auth/login/begin
curl -sk -X POST -H "content-type: application/json" --data "{}" \
  -o /dev/null -w "status=%{http_code} size=%{size_download} time=%{time_total}\n" \
  "$URL"
```

## Reading the output

### Edge-cached fallback (good)

```
/.env                          HTTP/2 200  cf-cache-status: HIT  content-type: text/html  cache-control: public, max-age=0, must-revalidate
/admin                         HTTP/2 200  cf-cache-status: HIT  content-type: text/html
```

`cf-cache-status: HIT` + `content-type: text/html` on a path that doesn't exist in your app means **the edge served your SPA's `index.html` from cache. The Worker did not run.** Bots probing these paths are free for you.

The bot, of course, doesn't know this — it gets a 200 + HTML and has no signal to give up. So you'll keep getting probed, but it costs you nothing per probe.

`max-age=0, must-revalidate` looks like it should defeat caching but the edge keeps the cached entry and serves it with a revalidation hint; that's the desired behavior here.

### Authenticated route, no cookie (good)

```
/api/cats                      HTTP/2 401  content-type: application/json
```

**Critical**: 401 with `application/json`, **not** HTML. This means session middleware short-circuited before any DB query. Verify by reading `worker/middleware/session.ts` — the cookie check should return 401 before any `await db.select(...)` call.

If you see HTML here instead of JSON, your `notFound` handler is catching `/api/*` and falling through to the SPA — fix the routing so unknown `/api/*` paths return JSON 404 (or the explicit 401 from session middleware).

### Public unauthenticated POST (your protection target)

```
status=200 size=188 time=0.045
{"options":{"rpId":"...","challenge":"...","allowCredentials":[],"timeout":60000,"userVerification":"preferred"}}
```

This is the route you need to rate-limit. Every call:
- Generates a random challenge (CPU)
- Signs a JWT (CPU)
- Sets a cookie (small alloc)
- Costs one Worker invocation

For a low-traffic family app, 30 req/60s/IP is comfortable. For a public app with legitimate signup volume, set the limit higher and split unauth-burst-protection into a CAPTCHA layer (Turnstile).

### Suspicious results

| Symptom | What it means | Fix |
|---|---|---|
| `HTTP/2 500` on a random path | `app.onError` is leaking | Make `app.onError` return `{error:{type:"internal"}}` with no stack trace |
| `HTTP/2 200` + `content-type: text/javascript` on `/.env` | source map or asset misconfiguration | Check `assets.directory` and `.assetsignore` in `wrangler.jsonc` |
| `HTTP/2 200` on `/.git/config` with content `[core]` | `dist/` includes the `.git` dir | Add `.git` to `.assetsignore` and rebuild |
| `cf-cache-status: DYNAMIC` on a static path | the path is reaching the Worker | Either move it to assets or check that `not_found_handling: "single-page-application"` is set |
| `Server: cloudflare` + a Worker error string in body | unhandled exception is leaking | Add `app.onError` and avoid `throw` in handlers |

## Read your build output too

A surprising number of "leaked secret" incidents come from build artifacts that get deployed by accident. After running your build:

```bash
ls -la dist/                                    # what's actually shipped?
find dist/ -name ".env*" -o -name "*.bak" -o -name "*.pem" -o -name "*.key"
cat dist/<worker>/.assetsignore                 # exclude list (Wrangler honors this)
```

For Cloudflare Workers + Vite + Wrangler, the typical layout is:

```
dist/
├── <worker-name>/
│   ├── index.js              # the Worker bundle (deployed)
│   ├── wrangler.json         # generated full config (NOT deployed if in .assetsignore)
│   ├── .dev.vars             # generated copy (NOT deployed if in .assetsignore)
│   └── .vite/
└── client/                   # actually served via the ASSETS binding
    ├── index.html
    ├── assets/
    └── .assetsignore
```

The Worker bundle (`dist/<worker-name>/index.js`) is what runs at the edge — its filesystem is **not** browsable to clients. The `dist/client/` tree is what gets served via the `ASSETS` binding — that **is** browsable. Confirm `.dev.vars` and `wrangler.json` are not in the `client/` tree.

## What to do with the audit results

Compile a one-page table for your defense plan:

| Path / route group | Edge cache | Auth required | DB hit | Action |
|---|---|---|---|---|
| `/`, `/index.html`, `/assets/*` | HIT | No | No | None |
| Wordlist scan paths (`/.env`, `/admin`, ...) | HIT (SPA fallback) | No | No | None |
| `/api/*` (authenticated) | DYNAMIC | Yes | Sometimes | None — middleware gates pre-DB |
| `/api/auth/login/begin` (POST) | DYNAMIC | No | No | **Rate limit** |
| `/api/auth/login/verify` (POST) | DYNAMIC | No | Yes | **Rate limit** |
| `/api/auth/register/begin` (POST) | DYNAMIC | No | Conditional | **Rate limit** (and gate by registration token) |
| `/health` | DYNAMIC | No | No | None |

The rate-limit list is short — 3-5 routes for a typical app. Resist the urge to blanket-apply.
