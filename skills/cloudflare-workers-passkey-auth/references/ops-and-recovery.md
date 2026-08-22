# Ops and recovery

## Configuration surface

`wrangler.jsonc` (production values, committed):

```jsonc
"vars": {
  // Credential-binding inputs. PERMANENT once the first passkey is registered.
  // Any PR that diffs these two lines gets rejected (routine-tasks ADR-0002).
  "RP_ID": "app.<your-subdomain>.workers.dev",
  "ORIGIN": "https://app.<your-subdomain>.workers.dev",
  "RP_NAME": "matatabetai"
}
```

Secrets (`wrangler secret put`): `SESSION_SECRET` (always), `INITIAL_REGISTRATION_TOKEN` (only during bootstrap).

`.dev.vars.example` (committed, keys only) → copy to `.dev.vars` (gitignored):

```bash
# openssl rand -hex 32
SESSION_SECRET=
# Local overrides of the wrangler.jsonc vars. RP_ID must equal the hostname you open in the browser.
RP_ID=localhost
ORIGIN=http://localhost:5173
# Only while trying the bootstrap flow locally; any string works in dev.
INITIAL_REGISTRATION_TOKEN=
# Skip passkeys in dev. Honored ONLY when ORIGIN is localhost/127.0.0.1. Never put in prod.
DEV_BYPASS_USER_ID=00000000-0000-4000-8000-000000000000
```

e2e vars (per `cloudflare-workers-e2e-playwright`): `RP_ID=localhost`, `ORIGIN` = Playwright `baseURL` exactly, no `DEV_BYPASS_USER_ID`.

## Bootstrap the first user (initial registration token cycle)

```bash
# 1. mint + store the one-shot secret
openssl rand -hex 32 | pnpm exec wrangler secret put INITIAL_REGISTRATION_TOKEN
# 2. hand the printed value to the first user out-of-band (in person / a chat you control)
#    → they open the app, "Register", enter display name + token → passkey sheet → logged in
# 3. close the door immediately
pnpm exec wrangler secret delete INITIAL_REGISTRATION_TOKEN
# 4. confirm
pnpm exec wrangler secret list        # must NOT show INITIAL_REGISTRATION_TOKEN or DEV_BYPASS_USER_ID
```

Rules:
- While the secret is unset, `register/begin` answers `403 registration_closed` — the door is shut by default, including in the minutes after a fresh deploy.
- Everyone after the first user joins through a **space invite** (`cloudflare-workers-space-membership-invite`), never through this token. The token exists for exactly two moments: day one, and owner recovery (below).
- Ask every new user to register a **second device** right after onboarding (`POST /api/auth/credentials/add/*`, "Add this device" in the UI). With a single passkey, a lost phone is an operator task.

## Rotate `SESSION_SECRET`

Consequences: every session JWT and every pending challenge cookie fails verification → everyone is logged out, and the `sessions` rows become orphans.

```bash
openssl rand -hex 32 | pnpm exec wrangler secret put SESSION_SECRET
pnpm exec wrangler d1 execute <db> --remote --command "DELETE FROM sessions"
```

No passkey is affected — credentials are bound to `RP_ID`, not to the secret.

## A user lost every passkey

Two options, cheapest first.

**A. Re-open the initial token (no code)** — routine-tasks ADR-0002 runbook:
1. `openssl rand -hex 32 | wrangler secret put INITIAL_REGISTRATION_TOKEN`
2. The person registers again → this creates a **new** `users` row (and, with spaces, a new space with them as owner).
3. `wrangler secret delete INITIAL_REGISTRATION_TOKEN`.
4. Re-attach them to the family space: an existing owner issues an invite and they accept it from the new account, or you `INSERT INTO space_members` by hand. Rows they created earlier keep pointing at the old `user_id` (`created_by` is audit data, not authorization — sibling skill), so nothing is lost; the old user row can stay or be deleted (`DELETE FROM users WHERE id = ?` cascades its dead credentials/sessions).

**B. Pre-build a recovery path (≈15 lines, optional)**: accept `recoveryUserId` alongside `initialRegistrationToken` in `register/begin`; when both are present and the secret matches, issue the challenge with state `{ kind: "add-credential", uid: recoveryUserId }` instead of `initial`, and have `register/verify` accept that kind by inserting only the credential. Same secret discipline (put → use → delete). Keeps the original `user_id` and memberships; worth it once the app has per-user data that is not space-shared.

Whatever you pick, the data safety net is the D1 backup / Time Travel from `cloudflare-d1-weekly-backup-via-pr` — a botched manual `INSERT`/`DELETE` is recoverable, a botched `RP_ID` change is not.

## Forced `RP_ID` / `ORIGIN` change (avoid; if unavoidable)

Cases that force it: Cloudflare account-subdomain rename (nyalog, 2026-06), moving to a custom domain after launch. Every passkey becomes invalid the moment the new value deploys.

1. Tell every user *before* deploying: "after the update you'll register again from an invite link".
2. Deploy the new `RP_ID` + `ORIGIN` together (they always move as a pair; an `ORIGIN` mismatch alone breaks every ceremony with `challenge_mismatch`).
3. Re-open the initial token for the owner, then issue invites for everyone else; old `credentials` rows are dead weight — delete them per user, or delete the old users entirely if their data is space-shared.
4. Write the new value into the ADR that pins it, and add the "reject diffs to `vars.RP_ID`/`vars.ORIGIN`" rule to the project's CLAUDE.md review checklist.

## Periodic checks (monthly, 2 minutes)

```bash
pnpm exec wrangler secret list                      # only SESSION_SECRET (+ your app's own secrets)
pnpm exec wrangler d1 execute <db> --remote --command \
  "SELECT u.display_name, COUNT(c.id) AS passkeys FROM users u LEFT JOIN credentials c ON c.user_id = u.id GROUP BY u.id"
#  → anyone with 1 passkey gets a nudge to add a second device
pnpm exec wrangler d1 execute <db> --remote --command \
  "SELECT COUNT(*) FROM sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')"
#  → if it grows, add the weekly DELETE sweep (schema.md "Cleanup")
```

## Incident log (feed back as you hit things)

| Date | Symptom | Cause | Fix | Section updated |
|---|---|---|---|---|
| (routine-tasks, 2026-04) | every iPhone user `401` on login | strict counter `<=` check, synced passkeys report 0 | `stored !== 0` exemption | SKILL.md "Login" |
| (nyalog, 2026-06) | all passkeys invalid after account-subdomain rename | `RP_ID` changed | everyone re-registered | this file, "Forced change" |
| | | | | |
