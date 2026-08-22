# Schema: users / credentials / sessions

Three tables, all with `TEXT` ids and ISO-8601 `TEXT` timestamps (what `new Date().toISOString()` writes; sorts correctly, readable in dumps).

## Drizzle (`worker/db/schema.ts`)

```typescript
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(), // crypto.randomUUID()
  displayName: text("display_name").notNull(),
  createdAt: text("created_at").notNull(),
});

export const credentials = sqliteTable(
  "credentials",
  {
    // WebAuthn credential ID exactly as @simplewebauthn returns it (base64url string).
    // Login looks this up by `response.id`, so it must be the primary key.
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // COSE public key bytes, base64url-encoded (see "Why TEXT" below).
    publicKey: text("public_key").notNull(),
    // Signature counter from the authenticator. 0 forever for most synced passkeys.
    counter: integer("counter").notNull(),
    // JSON array of AuthenticatorTransportFuture ("internal", "hybrid", ...) or null.
    transports: text("transports"),
    // User-supplied label shown in the device list ("iPhone", "1Password", "YubiKey").
    deviceName: text("device_name"),
    // registrationInfo.credentialBackedUp — survives a lost device (iCloud / Google PM).
    backedUp: integer("backed_up", { mode: "boolean" }).notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
  },
  (t) => ({ userIdIdx: index("credentials_user_id_idx").on(t.userId) }),
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(), // the `sid` claim of the session JWT; crypto.randomUUID()
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: text("expires_at").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    userIdIdx: index("sessions_user_id_idx").on(t.userId),
    expiresAtIdx: index("sessions_expires_at_idx").on(t.expiresAt),
  }),
);

// Insert shapes shared with cloudflare-workers-space-membership-invite (worker/spaces/registration.ts).
export type NewUser = typeof users.$inferInsert;
export type NewCredential = typeof credentials.$inferInsert;
```

## Generated SQL (what `drizzle-kit generate` should produce)

```sql
CREATE TABLE `users` (
  `id` text PRIMARY KEY NOT NULL,
  `display_name` text NOT NULL,
  `created_at` text NOT NULL
);

CREATE TABLE `credentials` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `public_key` text NOT NULL,
  `counter` integer NOT NULL,
  `transports` text,
  `device_name` text,
  `backed_up` integer NOT NULL,
  `created_at` text NOT NULL,
  `last_used_at` text,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `credentials_user_id_idx` ON `credentials` (`user_id`);

CREATE TABLE `sessions` (
  `id` text PRIMARY KEY NOT NULL,
  `user_id` text NOT NULL,
  `expires_at` text NOT NULL,
  `created_at` text NOT NULL,
  FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX `sessions_user_id_idx` ON `sessions` (`user_id`);
CREATE INDEX `sessions_expires_at_idx` ON `sessions` (`expires_at`);
```

## Why TEXT (base64url) for the public key

- nyalog stores `public_key` as base64url `TEXT`; routine-tasks as `BLOB` bound straight from the `Uint8Array` via raw `D1PreparedStatement.bind()`.
- `TEXT` wins for this stack: the committed weekly SQL dump stays greppable, `wrangler d1 execute ... --command "SELECT ..."` output is readable, and you avoid Drizzle's `blob()` column modes (whose `buffer` mode is typed as a Node `Buffer` you don't have in a Worker). A COSE EC2 key is ~77 bytes; base64url makes it ~104 characters. Nothing to optimize.
- Convert at the boundary only (helpers in `auth-routes.md`): `toBase64Url(registrationInfo.credential.publicKey)` on the way in, `fromBase64Url(row.publicKey)` into `verifyAuthenticationResponse({ credential: { publicKey } })` on the way out.

## Ids and handles

- `users.id` is a UUID generated **at `register/begin`** (`pendingUserId`), signed into the challenge cookie, and used as the WebAuthn `userID` handle (`new TextEncoder().encode(uuid)`). `verify` inserts the row with that same id — no second id is minted, so a retried `verify` cannot create two users.
- `credentials.id` is the authenticator's credential id. Re-registering the same authenticator for the same user is prevented client-side by `excludeCredentials` (→ `InvalidStateError`), server-side by the primary key.

## Migration-order note (read before you "just add a column" later)

`users` is a parent with `ON DELETE CASCADE` children (`credentials`, `sessions`, and — with spaces — `space_members`). A later Drizzle migration that **rebuilds** `users` (NULL → NOT NULL, type change, rename) is the D1 cascade-delete trap documented in `cloudflare-d1-drizzle-migration`: D1 ignores `PRAGMA foreign_keys=OFF`, the rebuild's `DROP TABLE` fires the cascades, and every passkey and session disappears. Decide the `users` columns now; if you must rebuild it later, follow that skill's backup + row-count runbook.

## Cleanup

- Expired `sessions` rows are deleted lazily when their cookie is presented (`sessionMiddleware`). A session that is never presented again stays until you sweep it. Optional weekly Cron: `DELETE FROM sessions WHERE expires_at < ?` with `new Date().toISOString()` — the `sessions_expires_at_idx` index exists for this.
- Deleting a user (`DELETE FROM users WHERE id = ?`) cascades to its credentials and sessions — that *is* the "remove this person entirely" operation. Removing someone from a space without deleting the account is the sibling skill's `DELETE /members/:userId`.
