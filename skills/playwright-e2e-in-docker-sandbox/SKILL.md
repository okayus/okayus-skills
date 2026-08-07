---
name: playwright-e2e-in-docker-sandbox
description: Run a Playwright e2e suite fully inside a network-isolated Docker sandbox (the claude-code-docker-sandbox setup — egress firewall, no host browser, no Cloudflare login) with zero runtime egress and zero credentials. The move — bake Chromium into the image at build time (build runs before the firewall), so the runtime allowlist needs no new entry. Use when e2e must run in-container (Playwright CDN blocked, `browser not found`), or when a credential-free `wrangler dev` accepts TCP but every request hangs — the two sandbox-only traps are a rate-limit binding (wrangler 3.x `unsafe` form or the v4 top-level `ratelimits` key) proxying to a remote Cloudflare resource whose handshake never completes without credentials, and a `localhost` bind stalling on IPv4/IPv6 dual-stack resolution (bind `--ip 127.0.0.1` end to end). Covers the Dockerfile bake block, `--no-sandbox` gated on DEVCONTAINER, exact version pinning (a blocked CDN can't self-heal drift), and stripping rate limits from the built e2e config.
license: MIT
compatibility: Designed for Claude Code and similar agents. Assumes the `claude-code-docker-sandbox` environment (Docker Compose, default-deny egress firewall, bind-mounted repo) and a Playwright suite that targets a local `wrangler dev` server — typically wired per `cloudflare-workers-e2e-playwright`. The bake recipe installs Chromium; adapt for other browsers.
metadata:
  author: okayus
  version: "0.1.0"
---

# Playwright e2e inside the Docker sandbox (credential-free, zero runtime egress)

If you develop in a network-isolated Docker sandbox (egress firewall, no host browser, no
Cloudflare login — the [`claude-code-docker-sandbox`](../claude-code-docker-sandbox/SKILL.md)
setup), a Playwright suite can still run **in-container with zero runtime egress**. The
enabling idea is that sandbox skill's core rule: **the firewall is the runtime
*entrypoint*, so anything whose network need is only at build time can be baked into the
image and never touches the runtime allowlist.** A browser is exactly that — bake it.

This skill assumes the e2e suite itself is already wired per
[`cloudflare-workers-e2e-playwright`](../cloudflare-workers-e2e-playwright/SKILL.md)
(build-artifact serving, `--persist-to`, auth seams, 3-spec scope). What lives here is
only the sandbox-specific layer: the bake, and the two traps that only bite when
`wrangler dev` runs **credential-free**.

## When to use this skill

- e2e must run inside the sandbox container: there's no host browser, and the egress
  firewall blocks the Playwright CDN, so a runtime `playwright install` can't work
- `pnpm e2e` in-container fails with `browser not found`
- A **credential-free** `wrangler dev` (sandbox, or a logged-out host) logs `Ready` and
  accepts TCP, but **every request hangs with no response** — Traps 1-2 below
- You're deciding whether in-container e2e needs new egress-allowlist entries (it needs
  **zero** — that's the point)

Do **not** use for:
- Wiring the e2e suite itself (the CSP/HMR trap, `--persist-to`, WebAuthn/OAuth seams,
  test scope) — that's [`cloudflare-workers-e2e-playwright`](../cloudflare-workers-e2e-playwright/SKILL.md)
- Non-sandboxed environments — a plain `playwright install chromium` on the host is fine

## Deliverables (completion criteria)

- [ ] Browser **baked at image-build time** via the `INSTALL_PLAYWRIGHT` build arg — zero
      runtime egress, no `init-firewall.sh` change
- [ ] `ARG PLAYWRIGHT_VERSION` **exactly equals** `@playwright/test` in `package.json`,
      and both are bumped together (rebuild after)
- [ ] Chromium `--no-sandbox` gated on the `DEVCONTAINER` env marker — host runs keep the
      real browser sandbox
- [ ] The built e2e config **strips the rate-limit binding** (`unsafe` *and* `ratelimits`)
- [ ] `wrangler dev` binds `--ip 127.0.0.1` (not `localhost`), and `ORIGIN` + Playwright
      `baseURL` use the same literal host

## Bake the browser at image-build time

`docker compose build` runs **before** `init-firewall.sh` (the runtime entrypoint), so the
build has open network — fetch Chromium and its OS libs there. At runtime the CDN is
blocked, but nothing needs it: e2e drives a **local** `wrangler dev` on `127.0.0.1`, and
with the OAuth round-trip replaced by the seeded-session seam there is **no external
egress at all** during the run.

Opt in via two knobs (the full Dockerfile block is the canonical copy in
[references/in-container-playwright-bake.md](references/in-container-playwright-bake.md) —
don't duplicate it into your own notes; drift between copies is exactly how the version-pin
trap happens):

```yaml
# docker-compose.yml — then: docker compose down && docker compose build && docker compose up -d
build:
  args:
    INSTALL_PLAYWRIGHT: "true"   # adds ~0.4 GB to the image
```

Key rules the block implements (the "five details" in the reference):
`PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` + `chmod a+rX` (root installs, `node` reads),
`apt-get update` before `--with-deps`, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` at runtime,
and the **exact version pin in two places**: the runtime CDN is blocked, so an
`ARG PLAYWRIGHT_VERSION` ≠ `@playwright/test` drift cannot self-heal — it surfaces as
`browser not found` until you bump both and rebuild.

Gate Chromium's own sandbox off **only in-container** (the container has `NET_ADMIN` but
not `SYS_ADMIN`, so the setuid sandbox can't initialize):

```typescript
// playwright.config.ts — the sandbox Dockerfile sets ENV DEVCONTAINER=true
launchOptions: process.env.DEVCONTAINER ? { args: ["--no-sandbox"] } : {},
```

This is the same build-time-vs-runtime-network pattern as the Rust/Haskell toolchains in
`claude-code-docker-sandbox`: compiler at build time = no allowlist entry; deps at runtime
= allowlist needed.

## Trap 1: the rate-limit binding hangs every local request

Symptom: `wrangler dev` logs `Ready` and the port accepts TCP, but **every request hangs**
with no response; the startup log says `connected to remote resource`.

Rate limiting reaches `wrangler dev` as a binding it can't simulate locally — wrangler 3.x
wires it via the `unsafe` binding form, wrangler 4.36+ as the top-level `ratelimits` key —
and the dev-time proxy to the **remote** Cloudflare resource never completes its handshake
in a credential-free environment, blocking the whole pipeline. Fix: **strip both keys**
from the built config before serving it for e2e. The limiter is fail-open and rate
limiting is out of e2e scope (verify it via
[`cloudflare-workers-bot-scan-defense`](../cloudflare-workers-bot-scan-defense/SKILL.md)),
so nothing of value is lost:

```typescript
// e2e/prepare-config.ts — post-build, editing dist/<bundle>/wrangler.json
const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
delete cfg.unsafe;      // wrangler 3.x form (observed to hang credential-free)
delete cfg.ratelimits;  // wrangler 4.36+ form (local behavior undocumented — strip it too)
```

## Trap 2: bind `--ip 127.0.0.1`, not `localhost`

Symptom: `wrangler dev` is "Ready", TCP connects, but the Worker **never returns a byte** —
no CSP error, no SQLite error, just a stall. Bound to `localhost` (the `dev.ip` default),
routing stalls on IPv4/IPv6 resolution in the container (`localhost` → both `127.0.0.1`
and `::1`). Fix: use `127.0.0.1` literally **end to end** — the bind, `ORIGIN`, and
Playwright `baseURL` must all agree (a host/`ORIGIN` mismatch also 403s mutations via the
CSRF check):

```jsonc
"e2e:server": "… wrangler dev --config dist/<bundle>/wrangler.json --persist-to .wrangler/state --ip 127.0.0.1 --port 5399"
```

Also pin `dev.ip` in the built config (`prepare-config.ts`:
`cfg.dev = { ...cfg.dev, ip: "127.0.0.1" }`) so a stray flag-less `wrangler dev` stays
consistent. When e2e hangs at connect-but-no-response, these two traps are the suspects —
rule out the bind address first (cheaper to check).

## Scope boundary — what this skill does NOT cover

- The e2e suite wiring itself (build-artifact serving, `--persist-to` state trap,
  WebAuthn / OAuth seams, 3-spec scope) — [`cloudflare-workers-e2e-playwright`](../cloudflare-workers-e2e-playwright/SKILL.md)
- The sandbox environment itself (firewall, compose files, allowlist tuning) —
  [`claude-code-docker-sandbox`](../claude-code-docker-sandbox/SKILL.md)
- Verifying rate-limiting behavior (deliberately stripped here) —
  [`cloudflare-workers-bot-scan-defense`](../cloudflare-workers-bot-scan-defense/SKILL.md)

## References

- [references/in-container-playwright-bake.md](references/in-container-playwright-bake.md) —
  the canonical Dockerfile block, the five details that matter, bake verification, and
  both traps in full diagnostic detail
