# Schema, crypto helpers, secrets

All from mazuoboeru (`apps/web/worker/db/schema.ts`, `drizzle/0001_phase1_slice.sql`, `worker/lib/*.ts`), generalised: replace `app_pat_` with your own prefix.

## `worker/db/schema.ts` — the `api_token` table

```ts
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { user } from "./user"; // your users table (mazuoboeru: `user`; the passkey skill: `users`)

// Personal access tokens. The raw token is never stored: token_hash = sha256(token + PAT_PEPPER).
// revoked_at is a soft flag so the row keeps its audit trail (name, created_at, last_used_at).
export const apiToken = sqliteTable(
  "api_token",
  {
    id: text("id").primaryKey(), // public id (shown in the UI, used in DELETE) — NOT the token
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(), // user-chosen label, e.g. "claude-laptop"
    tokenHash: text("token_hash").notNull(), // sha256 hex of token + pepper
    scopes: text("scopes").notNull(), // JSON array of Scope, e.g. ["quiz:read","quiz:write"]
    createdAt: integer("created_at").notNull(), // epoch ms
    lastUsedAt: integer("last_used_at"), // epoch ms, throttled (≤ 1 write / hour / token)
    expiresAt: integer("expires_at"), // epoch ms, or NULL = never
    revokedAt: integer("revoked_at"), // epoch ms, or NULL = live
  },
  (t) => [
    uniqueIndex("idx_api_token_hash").on(t.tokenHash), // the auth hot path: one point read
    index("idx_api_token_user").on(t.userId, t.revokedAt), // the settings list
  ],
);

export type ApiToken = typeof apiToken.$inferSelect;
```

Generated SQL (as applied in production):

```sql
CREATE TABLE api_token (
  id           TEXT PRIMARY KEY NOT NULL,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  scopes       TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at   INTEGER,
  revoked_at   INTEGER
);
CREATE UNIQUE INDEX idx_api_token_hash ON api_token (token_hash);
CREATE INDEX idx_api_token_user ON api_token (user_id, revoked_at);
```

### Choices explained

- `ON DELETE CASCADE` on `user_id`: a deleted account takes its tokens with it. `api_token` is a leaf (nothing references it), so it never takes part in the D1 table-rebuild cascade trap (`cloudflare-d1-drizzle-migration`) — adding it later is a purely additive migration.
- `revoked_at` instead of `DELETE`: keeps name / created / last-used for "when did this token die?" and makes a double revoke idempotent.
- `scopes` as JSON TEXT, not a join table: the set is tiny and read on every request; parse defensively (below).
- Timestamps as epoch-ms integers (mazuoboeru). The passkey skill uses ISO strings — pick your app's convention; the logic doesn't care.
- `expires_at` nullable: NULL = no expiry (mazuoboeru's default for agent tokens).

## `worker/lib/crypto.ts` — WebCrypto only

```ts
// Crypto helpers shared by sessions and PATs. All use the Workers Web Crypto API.

function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A URL-safe random token (default 32 bytes = 256 bits of entropy).
export function randomToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

// Lowercase hex sha256. Used to store only the *hash* of session tokens and PATs,
// so a DB leak can't be replayed as a live credential.
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

Why plain sha256 and not bcrypt / argon2 / PBKDF2: the input is 256 random bits, not a human password, so a slow hash buys nothing against guessing and costs CPU on every authenticated request. (WebCrypto has no argon2 / bcrypt; PBKDF2 exists but is the wrong tool here.) The pepper is what separates "I have the DB" from "I can verify a guess".

## `worker/lib/json.ts` — defensive scope parsing

```ts
// Defensive parse of a TEXT column that stores a JSON array of strings — e.g.
// api_token.scopes. Returns [] on malformed JSON or a non-array shape: a corrupt cell
// is treated as "empty", never thrown. The single hardening point for the JSON-array
// column boundary.
export function parseStringArray(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
  } catch {
    return [];
  }
}
```

`[]` on corruption is deliberate: a token whose scopes cell is unreadable still authenticates (the user is real) but can do nothing scoped — fail closed on permissions, not on identity.

## `worker/lib/id.ts`

```ts
// Entity ids are random UUIDs (v4). crypto.randomUUID is available in Workers.
export function newId(): string {
  return crypto.randomUUID();
}
```

## Secrets: `PAT_PEPPER`

`.dev.vars.example` (committed, keys only):

```
# Pepper mixed into PAT hashes: sha256(token + PAT_PEPPER). Any long random string.
# Local dev uses its own value; production is set with `wrangler secret put PAT_PEPPER`.
PAT_PEPPER=
```

Production:

```sh
openssl rand -hex 32 | pnpm exec wrangler secret put PAT_PEPPER
pnpm exec wrangler secret list      # shows the NAME only
```

`validatePat` tolerates an unset pepper (`env.PAT_PEPPER ?? ""`) so local dev works without one — but every hash computed without it differs from every hash computed with it, so **set it before the first token is minted** in each environment and never change it casually (see the ops reference). With Workers Builds keyless deploys (`cloudflare-workers-builds-keyless-deploy`) the secret is put from the host once; it never passes through GitHub.

`worker/types.ts` addition:

```ts
export type Bindings = {
  // …
  PAT_PEPPER?: string; // Worker Secret in prod; .dev.vars locally. Optional so dev runs without it.
};
```
