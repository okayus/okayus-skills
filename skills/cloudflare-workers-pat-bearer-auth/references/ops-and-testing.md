# Ops, incidents, tests

## Pepper lifecycle

```sh
# once per environment, BEFORE the first token is minted
openssl rand -hex 32 | pnpm exec wrangler secret put PAT_PEPPER
# local: put a different value in .dev.vars (gitignored)
```

**Rotation = every PAT becomes invalid** (their stored hashes were computed with the old pepper). There is no gradual rotation unless you add a `pepper_version` column and keep both secrets for a window — not built; don't pretend otherwise. Procedure when you must:

1. Announce ("all API tokens stop working at T; re-mint in Settings").
2. `wrangler secret put PAT_PEPPER` with a new value (this deploys a new version).
3. Optionally `UPDATE api_token SET revoked_at = <now> WHERE revoked_at IS NULL` so the UI shows them as dead instead of silently failing.
4. Users mint new tokens; agents get new env vars.

When you **don't** need to rotate: a single leaked token (revoke it), a leaked DB dump (hashes are useless without the pepper, and 256-bit tokens are unguessable even with it).

## Leak runbook

1. Revoke: Settings → 失効, or `wrangler d1 execute <db> --remote --command "UPDATE api_token SET revoked_at = strftime('%s','now')*1000 WHERE id = '<id>'"`.
2. Check use after the leak: `last_used_at` (hourly granularity — it is a throttled write, so "last used" can be up to an hour stale).
3. Look at what the scope allowed (`quiz:write` can create / edit the user's own content, nothing else) and clean up.
4. Mint a replacement; update the caller's env / secret.

## Incident queries (never select `token_hash` into a chat or a ticket)

```sql
-- a user's tokens and their health
SELECT id, name, scopes, created_at, last_used_at, expires_at, revoked_at
FROM api_token WHERE user_id = ? ORDER BY created_at DESC;

-- tokens used in the last day, across users (abuse triage)
SELECT user_id, id, name, last_used_at FROM api_token
WHERE last_used_at > (strftime('%s','now') - 86400) * 1000 AND revoked_at IS NULL;

-- revoke everything for one user (account compromise)
UPDATE api_token SET revoked_at = strftime('%s','now')*1000 WHERE user_id = ? AND revoked_at IS NULL;
```

## Expiry policy

- `expires_at = NULL` (mazuoboeru's default): long-running agents, personal integrations. Revocation is the control.
- Fixed TTL (e.g. 90 days): human-operated CLIs on laptops. Add `expiresAt` as an optional field of `POST /api/tokens` and show the date in the list; `validatePat` already enforces it.
- Don't auto-delete expired rows — they are the audit trail. A periodic `DELETE … WHERE revoked_at < now - 1y` is plenty.

## Rate limiting PAT-reachable routes (UNVERIFIED wiring)

The unauthenticated cost of a PAT route is: `Bearer ` check → prefix check → (only for well-formed tokens) sha256 + one D1 point read. Junk is free; a targeted guess attack is one D1 read per attempt against 256 bits of search space — not a credential risk, a budget one. Reuse the bot-scan binding:

```jsonc
// wrangler.jsonc — a SECOND binding. The bot-scan skill's AUTH_RATE_LIMITER (30 / 60 s) is sized for
// login; sharing it would let one busy agent lock the user out of login.
"ratelimits": [
  { "name": "AUTH_RATE_LIMITER", "namespace_id": "1001", "simple": { "limit": 30, "period": 60 } },
  { "name": "API_RATE_LIMITER", "namespace_id": "1002", "simple": { "limit": 120, "period": 60 } } // ≥ your busiest agent's burst
]
```

```ts
// worker/types.ts: API_RATE_LIMITER?: RateLimit;   (optional → fails open in local dev / e2e)
// worker/middleware/rate-limit.ts — same fail-open shape as the bot-scan skill's authRateLimit
export const apiRateLimit = createMiddleware<Env>(async (c, next) => {
  const limiter = c.env.API_RATE_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: c.req.header("CF-Connecting-IP") ?? "unknown" });
    if (!success) return c.json(apiError("rate_limited"), 429);
  }
  await next();
});

// worker/routes/things.ts
.post("/", apiRateLimit, requireAuth, requireScope("thing:write"), handler)
```

Per-**user** write limits (a logged-in or token-bearing user spamming) are a different layer (key on `user.id` after `requireAuth`) — mazuoboeru lists it as pending and gates creation with an allowlist meanwhile.

## Logging rules

- Never `console.log(c.req.header("Authorization"))`, the raw token, or a request dump that includes headers. Workers Observability at `head_sampling_rate: 1` persists it.
- Log `{ tokenId, userId, route }` on suspicious outcomes (prefix OK but hash miss is the interesting one — a real-looking token that isn't yours).
- The token travels in the header only; never accept `?token=` or a cookie fallback.

## Tests

### What exists in the source project

- `apps/cli/src/request.test.ts` — table tests on the pure request builders: the `Authorization: Bearer …` header, method, body, base-URL normalisation, all with a fake token string (`"mzo_pat_abc"`). No network.
- `apps/cli/src/run.test.ts` — the env-var → command → request → exit-code mapping, with an injected `io`.
- Server side: **no** unit test for `validatePat` (it needs D1) and **no** PAT e2e spec. The 3-spec scope of `cloudflare-workers-e2e-playwright` covers the session paths; PAT verification before a release is `mzo whoami` + one `mzo create` by hand.

### Proposed API-level e2e spec (UNVERIFIED — not run)

Uses the seeded-session seam from `cloudflare-workers-e2e-playwright` (a real session row + its cookie), so no OAuth / WebAuthn round-trip is needed:

```ts
test("PAT: mint with a session, use as Bearer, cannot mint, dies on revoke", async ({ request }) => {
  const cookie = { Cookie: `session=${AUTHOR.token}`, Origin: BASE_URL }; // cookie routes need Origin (CSRF)
  const minted = await request.post("/api/tokens", { headers: cookie, data: { name: "e2e" } });
  expect(minted.status()).toBe(201);
  const created = (await minted.json()).token as { id: string; token: string };

  const bearer = { Authorization: `Bearer ${created.token}` }; // no Origin needed
  // /api/auth/me answers 200 { user: null } even for a bad token — judge by the body, never by .ok()
  const me = (await (await request.get("/api/auth/me", { headers: bearer })).json()) as { user: unknown };
  expect(me.user).not.toBeNull();
  expect((await request.post("/api/things", { headers: bearer, data: { title: "t" } })).status()).toBe(201);
  expect((await request.post("/api/tokens", { headers: bearer, data: { name: "x" } })).status()).toBe(403); // session_required

  expect((await request.delete(`/api/tokens/${created.id}`, { headers: cookie })).ok()).toBeTruthy();
  expect((await request.post("/api/things", { headers: bearer, data: { title: "t" } })).status()).toBe(401);
});
```

### Unit-testing the decision without D1 (suggested seam)

If you want `validatePat`'s revoked / expired / throttle logic under vitest (node env), split the pure decision out:

```ts
export function tokenState(
  t: { revokedAt: number | null; expiresAt: number | null },
  now: number,
): "live" | "revoked" | "expired" {
  if (t.revokedAt !== null) return "revoked";
  if (t.expiresAt !== null && t.expiresAt < now) return "expired";
  return "live";
}
export function shouldTouchLastUsed(lastUsedAt: number | null, now: number): boolean {
  return lastUsedAt === null || now - lastUsedAt > LAST_USED_THROTTLE_MS;
}
```

and call them from `validatePat`. Table tests on those two functions cover every branch that matters; the D1 query itself is exercised by the e2e above.
