# Token routes, CSRF exemption, settings UI, callers

## `worker/routes/tokens.ts` — session-only management

```ts
import { Hono } from "hono";
import { z } from "zod";
import { requireSession, requireUser } from "../auth/middleware";
import { createToken, listTokens, revokeToken } from "../auth/pat";
import { apiError } from "../http/errors";
import type { Env } from "../types";

const createSchema = z.object({ name: z.string().trim().min(1).max(100) });

// PAT management. Session-only (a PAT must not be able to mint or revoke PATs).
export const tokensRouter = new Hono<Env>()
  .use("*", requireSession)

  .get("/", async (c) => {
    const user = requireUser(c);
    const tokens = await listTokens(c.env, user.id);
    return c.json({ tokens });
  })

  .post("/", async (c) => {
    const user = requireUser(c);
    const body = (await c.req.json().catch(() => null)) as unknown;
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) return c.json(apiError("invalid_body"), 400);
    // The raw token is returned here exactly once and never again.
    const token = await createToken(c.env, user.id, parsed.data.name);
    return c.json({ token }, 201);
  })

  .delete("/:id", async (c) => {
    const user = requireUser(c);
    const ok = await revokeToken(c.env, user.id, c.req.param("id"));
    if (!ok) return c.json(apiError("not_found"), 404);
    return c.json({ ok: true });
  });
```

Method-chained on purpose: Hono RPC (`hc<AppType>`) infers response DTOs from the chain, so the SPA never re-declares `TokenSummary` / `CreatedToken` (mazuoboeru ADR-0011).

## `worker/index.ts` — mount order

```ts
const api = new Hono<Env>()
  .use("*", optionalAuth) // resolves PAT-or-session once for every /api route
  .get("/auth/me", (c) => {
    const user = c.get("user");
    return c.json({ user: user ? meJson(user) : null });
  })
  .post("/auth/logout", requireAuth, async (c) => {
    await destroySession(c);
    return c.json({ ok: true });
  })
  .route("/tokens", tokensRouter) // session-only inside
  .route("/quizzes", quizzesRouter) // requireAuth + requireScope per route
  .route("/public", publicRouter); // no auth

const app = new Hono<Env>()
  .use("*", securityHeaders)
  .use("*", csrf) // Bearer-exempt Origin check (below)
  .get("/health", (c) => c.json({ status: "ok" }))
  .route("/api", api);
```

`GET /api/auth/me` answers `200 { user: null }` when unauthenticated — a CLI `whoami` therefore judges by the body, not the status.

## `worker/middleware/security.ts` — the CSRF check, Bearer-exempt

```ts
// CSRF defense layer 2 (SameSite=Lax is layer 1): on state-changing methods,
// require the Origin header to equal our ORIGIN. Bearer (PAT) requests are exempt
// — they carry no ambient cookie credential, so a cross-site page can't forge them
// (it can't attach the victim's Authorization header).
export const csrf: MiddlewareHandler<Env> = async (c, next) => {
  const method = c.req.method;
  if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
    const authz = c.req.header("Authorization");
    const isBearer = authz?.startsWith("Bearer ") ?? false;
    if (!isBearer) {
      const origin = c.req.header("Origin");
      if (!origin || origin !== c.env.ORIGIN) {
        return c.json(apiError("csrf_origin_mismatch"), 403);
      }
    }
  }
  await next();
};
```

The exemption keys on the *presence* of a Bearer header, not on whether the token validated — an invalid token then fails at `requireAuth` with `401`, which is the right answer (and still no cookie was usable).

## Settings view (React) — show once, list, revoke

Trimmed from mazuoboeru `src/views/Settings.tsx` (SWR + the typed client):

```tsx
export function Settings() {
  const { data, error, mutate } = useSWR("tokens", () => api.listTokens(), {
    shouldRetryOnError: false,
  });
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedToken | null>(null);

  const create = async () => {
    const r = await api.createToken(name.trim());
    setCreated(r.token); // the only place the raw token ever exists client-side
    setName("");
    mutate();
  };
  const revoke = async (id: string) => {
    await api.revokeToken(id);
    mutate();
  };

  return (
    <div>
      <h2>PAT（API トークン）</h2>
      <p className="meta">
        CLI / AI エージェントが API を叩くための Bearer トークンです。発行直後の一度だけ表示されます。
      </p>
      <div className="card">
        <input
          placeholder="トークン名（例: claude-laptop）"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button onClick={create} disabled={!name.trim()}>
          発行
        </button>
      </div>
      {created && (
        <div className="card token-once">
          <strong>{created.name} を発行しました。今だけ表示されます:</strong>
          <code className="token">{created.token}</code>
          <p className="meta">スコープ: {created.scopes.join(", ")}</p>
        </div>
      )}
      {data && (
        <table className="tokens">
          <thead>
            <tr>
              <th>名前</th>
              <th>作成</th>
              <th>最終使用</th>
              <th>状態</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.tokens.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td>{new Date(t.createdAt).toLocaleDateString()}</td>
                <td>{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleDateString() : "—"}</td>
                <td>{t.revokedAt ? "失効済み" : "有効"}</td>
                <td>
                  {t.revokedAt ? null : (
                    <button className="link" onClick={() => revoke(t.id)}>
                      失効
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

Typed client (`src/api.ts`), derived from the server chain:

```ts
export type TokenSummary = Ok<typeof client.api.tokens.$get>["tokens"][number];
export type CreatedToken = Ok<typeof client.api.tokens.$post>["token"];
// api.listTokens / api.createToken(name) / api.revokeToken(id) wrap
// client.api.tokens.$get / .$post / [":id"].$delete
```

`created` is component state only — do not put the raw token in a store, the URL, or local storage. Leaving the page forgets it, which is the contract the "今だけ表示されます" line promises.

## Callers

### CLI (`mzo`): env var, pure request builders

```ts
// apps/cli/src/request.ts — pure: (baseUrl, token, …) → { url, init }. No I/O, table-tested.
function authHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}
function getHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }; // GETs: no body, no Content-Type
}
export function createRequest(baseUrl: string, token: string, body: string): HttpRequest {
  return {
    url: joinUrl(baseUrl, "/api/quizzes"),
    init: { method: "POST", headers: authHeaders(token), body },
  };
}
export function meRequest(baseUrl: string, token: string): HttpRequest {
  return { url: joinUrl(baseUrl, "/api/auth/me"), init: { headers: getHeaders(token) } };
}
```

```ts
// apps/cli/src/run.ts — the only place the token is read
const token = io.env("MAZUOBOERU_PAT");
if (!token) {
  /* usage error, exit 2 */
}
```

User-facing contract (from the CLI README): *"PAT は Web の設定画面で発行する（session 限定発行＝CLI からは発行できない）。発行直後の平文を控え、env に入れる"* — `export MAZUOBOERU_PAT='mzo_pat_…'`, optional `MAZUOBOERU_BASE_URL=http://localhost:5373` for dev, `mzo whoami` as the smoke test.

### `curl` smoke

```sh
export APP_PAT='app_pat_…'
# who am I → {"user":{…}} (or {"user":null} for a bad token — judge by the body)
curl -s https://<host>/api/auth/me -H "Authorization: Bearer $APP_PAT"
# a mutation → 201, no Origin header needed
curl -s -X POST https://<host>/api/things -H "Authorization: Bearer $APP_PAT" \
     -H 'content-type: application/json' -d '{"title":"t"}'
# a PAT trying to mint a PAT → 403 {"error":"session_required"}
curl -s -X POST https://<host>/api/tokens -H "Authorization: Bearer $APP_PAT" \
     -H 'content-type: application/json' -d '{"name":"x"}'
```

### Another Worker, personal use (the "quiz app → diary app" push)

```jsonc
// sender's wrangler.jsonc
"vars": { "KOKEMUSU_URL": "https://kokemusu.<subdomain>.workers.dev" }
// secret: `wrangler secret put KOKEMUSU_PAT` — minted in the receiver's settings UI with post:write only
```

```ts
// sender: pure builder + throw-less boundary (cloudflare-cron-to-discord's architecture)
const body = buildDailyPost(results, now); // pure
await postWithBearer(`${env.KOKEMUSU_URL}/api/posts`, env.KOKEMUSU_PAT, body); // never throws; logs status only
```

## Receiver-side push endpoint (sketch — UNVERIFIED, kokemusu will be the first)

```ts
const postSchema = z.object({
  title: z.string().trim().min(1).max(200),
  tags: z.array(z.string().trim().min(1).max(50)).max(20),
  body: z.string().max(20_000),
  occurredAt: z.string().datetime().optional(), // the sender's event time; default now
});

export const postsRouter = new Hono<Env>()
  .post("/", requireAuth, requireScope("post:write"), async (c) => {
    const user = requireUser(c);
    const parsed = postSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(apiError("invalid_body"), 400);
    // Optional: `Idempotency-Key` header → (user_id, key) UNIQUE for 24 h, so a retrying
    // sender can't double-post. Design note; not in the source project.
    const post = await createPost(c.env, user.id, parsed.data);
    return c.json({ post }, 201);
  });
```

Nothing in the body says who sent it — that is the "receiver doesn't know the sender" contract. If the receiver wants to display a source, let the *sender* put it in `tags` or `title` by configuration.
