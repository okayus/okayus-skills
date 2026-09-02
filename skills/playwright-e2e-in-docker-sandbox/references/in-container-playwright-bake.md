# Running e2e fully inside a Docker sandbox (bake the browser at build time)

If your development happens in a network-isolated Docker sandbox — a default-deny egress
firewall, no host browser, no Cloudflare login (see the `claude-code-docker-sandbox`
skill) — you can still run the whole Playwright suite **in-container with zero runtime
egress**. The trick is the one rule that sandbox skill is built around: **the firewall is
the runtime entrypoint, so anything whose network need is only at *build* time can be
baked into the image and never touches the runtime allowlist.** A browser is exactly that.

This reference covers the bake, plus two traps that only bite when `wrangler dev` runs
**credential-free** (in a sandbox, or on a logged-out host).

## Why baking works: build-time network vs runtime firewall

`docker compose build` runs **before** `init-firewall.sh` (the container entrypoint), so
the build has unrestricted network. `playwright install --with-deps chromium` fetches the
browser binary *and* its apt library dependencies there. At **runtime** the firewall is up
and the CDN is blocked — but you don't need it: the browser is already on disk, and the
e2e drives a **local** `wrangler dev` on `127.0.0.1`. The only sockets the run opens are
browser → local Worker. With the OAuth round-trip replaced by the seeded-session seam (see
`cloudflare-workers-e2e-playwright`'s `references/oauth-seeded-session-seam.md`),
**external egress during e2e is zero** — nothing new in `init-firewall.sh`.

This is the same pattern as the Rust/Haskell toolchains in `claude-code-docker-sandbox`:
compiler at build time (no allowlist entry), dependencies at runtime (allowlist needed).
A browser is a build-time dependency. Bake it.

## The Dockerfile block (canonical copy — don't fork it elsewhere)

```dockerfile
# Playwright Chromium for in-container e2e. Fetched at BUILD time (network is open then),
# so NONE of this needs a runtime egress-allowlist entry. Installed into a shared path so
# the runtime non-root user can read it.
ARG INSTALL_PLAYWRIGHT=false
# PLAYWRIGHT_VERSION MUST equal @playwright/test in package.json (Dockerfile has no inline
# comments — keep the note on its own line so the value stays exactly "1.60.0").
ARG PLAYWRIGHT_VERSION=1.60.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
USER root
# apt-get update FIRST: an earlier layer cleaned /var/lib/apt/lists, so `--with-deps`
# (which apt-installs Chromium's shared libraries) would otherwise fail to find packages.
# Re-clean afterward to keep the layer lean.
RUN if [ "$INSTALL_PLAYWRIGHT" = "true" ]; then \
      apt-get update && \
      mkdir -p /ms-playwright && \
      npx --yes playwright@${PLAYWRIGHT_VERSION} install --with-deps chromium && \
      chmod -R a+rX /ms-playwright && \
      apt-get clean && rm -rf /var/lib/apt/lists/* ; \
    fi
USER node
# Stop `pnpm install` from re-downloading browsers at runtime (the CDN is blocked then) —
# the browser is already baked at PLAYWRIGHT_BROWSERS_PATH above.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
```

And opt in from `docker-compose.yml` (rebuild after changing it):

```yaml
build:
  args:
    INSTALL_PLAYWRIGHT: "true"   # adds ~0.4 GB to the image
```

```bash
docker compose down && docker compose build && docker compose up -d
```

### The variant both production users run (matatabetai 2026-08-22, kokemusu 2026-09-02)

Same five details, different mechanics — verified end to end in two projects on `node:24`
with playwright 1.62.1 (kokemusu: `docker compose build` ≈ 3 min, +0.4 GB, 10 e2e tests
green). Libraries as an explicit apt list in the root layer, the browser installed **as
`node`** so it lands in `/home/node/.cache/ms-playwright` and needs no shared path or
`chmod`; `fonts-noto-cjk` because a Japanese UI otherwise renders tofu in failure
screenshots:

```dockerfile
# root layer, right after the base apt-get block
ARG INSTALL_PLAYWRIGHT=false
RUN if [ "$INSTALL_PLAYWRIGHT" = "true" ]; then \
  apt-get update && apt-get install -y --no-install-recommends \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
  libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
  libpango-1.0-0 libcairo2 fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
  && apt-get clean && rm -rf /var/lib/apt/lists/* ; \
  fi

# later, as USER node (after the global npm install of claude)
# PLAYWRIGHT_VERSION MUST equal @playwright/test in package.json (exact pin, bump both).
ARG PLAYWRIGHT_VERSION=1.62.1
RUN if [ "$INSTALL_PLAYWRIGHT" = "true" ]; then \
      npx -y playwright@${PLAYWRIGHT_VERSION} install chromium ; \
    fi
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
```

`docker-compose.yml` opts in with `INSTALL_PLAYWRIGHT: "true"` and `PLAYWRIGHT_VERSION:
"1.62.1"` next to each other, so the pin is visible where the build is configured. Bake
output to expect: `chromium-<rev>/`, `chromium_headless_shell-<rev>/`, `ffmpeg-<rev>/`.

### The five details that matter

1. **`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` + `chmod -R a+rX`.** The install runs as
   `root`; the runtime user is `node`. A shared, world-readable path lets the non-root
   runtime read browsers installed by root. (Without the explicit path, Playwright caches
   under `~/.cache` of whoever installed it — here `root` — and `node` can't reach it.)

2. **`apt-get update` before `--with-deps`.** Base images (and earlier layers) routinely
   `rm -rf /var/lib/apt/lists/*` to shrink. `--with-deps` then can't resolve Chromium's
   libs. Update first; clean after.

3. **`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` at runtime.** Otherwise a `pnpm install` inside
   the running container tries to fetch browsers from the (now-blocked) CDN and either
   hangs or errors. The browser is already baked; tell the tooling to trust that.

4. **Exact-pin the version in two places and bump them together.**
   `ARG PLAYWRIGHT_VERSION` (baked browser) **must equal** `@playwright/test` in
   `package.json` (the test runner). The runtime CDN is blocked, so a drift **cannot
   self-heal** via `playwright install` — it surfaces as `browser not found` (or a
   protocol-version mismatch) until you bump **both** and rebuild the image. Treat a
   version bump as: edit both, `docker compose build`, run e2e once.
   Not every pin installs on every base image: `playwright@1.59.1 install chromium`
   **hangs forever after the download on `node:24`** (the `pw:install` log ends at
   `SUCCESS downloading …`, the extraction never finishes; `node:22` + 1.59.1 and
   `node:24` + 1.62.1 both complete in ~2 minutes — verified 2026-08-22 in matatabetai).
   When the build sits at `100% of … MiB` with no `#N DONE`, reproduce outside the
   build — `docker run --rm -e DEBUG=pw:install node:24 sh -c 'npx -y playwright@<ver>
   install chromium'` — and move the pin (and `@playwright/test`) to a version that
   completes, rather than retrying the build or suspecting the CDN.

5. **`--no-sandbox`, gated on the devcontainer.** The container has `NET_ADMIN`/`NET_RAW`
   (for the firewall) but **not** `SYS_ADMIN` / user-namespace cloning, so Chromium's
   setuid sandbox can't initialize and the browser won't launch. Disable it **only**
   in-container, keying off the devcontainer marker so the host keeps the real sandbox:

   ```typescript
   // playwright.config.ts — Dockerfile sets ENV DEVCONTAINER=true
   use: {
     ...devices["Desktop Chrome"],
     launchOptions: process.env.DEVCONTAINER ? { args: ["--no-sandbox"] } : {},
   }
   ```

   This is safe here because the browser only ever loads your own `127.0.0.1` app — but
   keep the gate so you never silently weaken the browser sandbox on a real machine.

### How to confirm the bake worked

```bash
# In-container, after `docker compose up -d`:
ls /ms-playwright                      # chromium-XXXX/ present
echo $PLAYWRIGHT_BROWSERS_PATH         # /ms-playwright
pnpm e2e                               # runs; no CDN fetch, no firewall change
```

If e2e reports `browser not found`, it's almost always the version drift in detail 4 —
check `PLAYWRIGHT_VERSION` against `@playwright/test` and rebuild.

## Trap 1: the rate-limit binding hangs every local request

**Symptom.** `wrangler dev` logs `Ready` and the TCP port accepts connections, but **every
request hangs with no response**. The startup log contains a line like
`connected to remote resource`.

**Why.** Wrangler 3.x has no top-level `ratelimits` config, so rate limiting is wired via
the `unsafe` binding form (`{ "unsafe": { "bindings": [{ "type": "ratelimit", … }] } }`).
`wrangler dev` **cannot simulate that binding locally** — it proxies to a **remote**
Cloudflare resource. In a credential-free sandbox (or on a logged-out host) the
auth/egress handshake for that remote resource never completes, and it blocks the request
pipeline — so the Worker is "Ready" yet returns nothing.

Wrangler **4.36+** expresses the same limiter as a top-level `ratelimits` key instead, and
**that form is simulated locally** — verified 2026-09-02 in kokemusu (wrangler 4.125.0,
credential-free container): under `vite dev` a 40-request burst against `simple: { limit:
30, period: 60 }` answered 26×200 + 14×429, and under `wrangler dev --config dist/…` 29×200
+ 11×429 — no hang, no `connected to remote resource` line. Strip it anyway: rate limiting
is out of e2e scope, and a live limiter means a burst of e2e requests (or a retried run)
can 429 your own auth routes.

**Fix.** Strip the rate-limit keys from the **built** config before serving it for e2e.
The limiter is fail-open and rate limiting is out of e2e scope (test it separately — see
the `cloudflare-workers-bot-scan-defense` skill), so removing it for the e2e Worker is
correct and keeps the run credential-free:

```typescript
// e2e/prepare-config.ts — post-build, pre-`wrangler dev`, editing dist/<bundle>/wrangler.json
const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
delete cfg.unsafe;      // wrangler 3.x ratelimit binding (observed to hang credential-free)
delete cfg.ratelimits;  // wrangler 4.x top-level form — simulated locally (verified 4.125.0), stripped for independence
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
```

**How to confirm it's this trap and not Trap 2.** Strip the keys, re-serve. If requests now
return, it was the binding. If they still hang at connect-but-no-byte, it's the bind
address — Trap 2.

## Trap 2: bind `--ip 127.0.0.1`, not `localhost`

**Symptom.** `wrangler dev` is "Ready", the TCP connection establishes, but the Worker
**never returns a byte** — requests hang at connect. No CSP error, no SQLite error; the
pipeline just stalls.

**Why.** Bound to `localhost` (wrangler's `dev.ip` default), request routing stalls on
IPv4/IPv6 name resolution inside the container — `localhost` resolves to both `127.0.0.1`
and `::1`, and the dual-stack hand-off doesn't complete. A minimal Worker bound to
`--ip 127.0.0.1` responds immediately, which isolates it as a **bind-name** problem, not a
Worker-logic one.

**Fix.** Use `127.0.0.1` literally, end to end — the bind, the `ORIGIN`, and Playwright's
`baseURL` must all agree (mismatched host vs `ORIGIN` also 403s mutations via the CSRF
Origin check):

```jsonc
// e2e:server script — NB: same --persist-to as your migrations (the main e2e skill's Trap 2)
"wrangler dev --config dist/<bundle>/wrangler.json --persist-to .wrangler/state --ip 127.0.0.1 --port 5399"
```

```typescript
// playwright.config.ts
const baseURL = "http://127.0.0.1:5399";   // NOT http://localhost:5399
```

```
# e2e worker vars
ORIGIN=http://127.0.0.1:5399               # must equal baseURL
```

Also pin it in the built config so a stray `wrangler dev` without the flag stays
consistent (`prepare-config.ts`):

```typescript
cfg.dev = { ...(cfg.dev ?? {}), ip: "127.0.0.1" };
```

If you ever see e2e requests hang at connect-but-no-response, this and Trap 1 are the two
suspects — check the bind address first (cheaper to rule out).

## Also config-relative: the `.dev.vars` copy in `dist/`

`@cloudflare/vite-plugin` 1.x (verified 1.53) copies `apps/web/.dev.vars` to
`dist/<worker>/.dev.vars` at build time, and wrangler resolves `.dev.vars` **relative to
the directory of the config it was given** (`path.resolve(dirname(configPath),
".dev.vars")` in `wrangler-dist/cli.js`). So `wrangler dev --config dist/<worker>/wrangler.json`
silently runs with the developer's values: `DEV_CSP=1` relaxes the CSP your security spec
asserts, `ORIGIN=http://localhost:5273` 403s every POST via the CSRF check and fails
WebAuthn verify with `challenge_mismatch`. Two verified ways out (kokemusu 2026-09-02):

- `prepare-config.ts` deletes the copy and writes the e2e values into `cfg.vars` (one
  source of truth in `e2e/env.ts`, nothing on the command line), or
- pass every key with `--var KEY:value` — the CLI outranks the copy (`--var RP_ID:vartest`
  shows up as `rpId` in `login/begin` with the copy present). matatabetai does this.

Precedence measured: `--var` > `.dev.vars` next to the config > `vars` in the config.

## See also

- `claude-code-docker-sandbox` → *"The one rule that explains the whole design: build-time
  vs runtime network"* — the general pattern this skill instantiates.
- `cloudflare-workers-e2e-playwright` → `references/oauth-seeded-session-seam.md` — why
  the run has no external egress to allowlist in the first place.
