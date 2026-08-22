# Ops: bootstrap, onboarding a family, recovery, cleanup

All remote SQL below goes through `pnpm exec wrangler d1 execute <db-name> --remote --command "…"`. Take a `wrangler d1 export <db-name> --remote --output=backups/<date>-<why>.sql` before anything that deletes (see `cloudflare-d1-weekly-backup-via-pr` for the scheduled version).

## 1. Bootstrap the first owner (no manual SQL)

The first registration goes through the passkey skill's `INITIAL_REGISTRATION_TOKEN` path; its `register/verify` calls this skill's `registerInitialUser(c.env.DB, user, cred)` (`references/invite-flow.md`), one batch: `users` → `spaces` → `space_members(owner)` → `credentials`. The session row is added right after by the passkey skill's `issueSession`.

Runbook:

```bash
openssl rand -hex 32 | pnpm exec wrangler secret put INITIAL_REGISTRATION_TOKEN
# → owner registers on the phone that will hold the primary passkey
pnpm exec wrangler secret delete INITIAL_REGISTRATION_TOKEN        # close the door
pnpm exec wrangler d1 execute <db-name> --remote --command \
  "SELECT s.name, sm.role, u.display_name FROM space_members sm JOIN spaces s ON s.id = sm.space_id JOIN users u ON u.id = sm.user_id"
```

Contrast: nyalog retrofitted spaces and needed a hand-written `space-bootstrap.sql` (create the space, join every user as owner, backfill `space_id` on existing rows) plus a NULL → NOT NULL migration afterwards. Designing per-space from day 1 removes all of it.

## 2. Onboard a family member

1. Owner, logged in: issue an invite (UI button → `POST /api/spaces/:spaceId/invites`). Copy the `url` (`https://<app>/#/invite?token=…`).
2. Send it over a private channel (LINE, in person). It is valid for 7 days and exactly once.
3. The family member opens it on **the phone that will hold their passkey** and registers (display name + biometrics). Cross-device passkeys (iCloud Keychain / Google Password Manager) make a second device painless later via "add passkey".
4. Owner verifies: `GET /api/spaces/:spaceId/members` shows the new `member`.
5. If the link dies (`invite_expired` / `invite_consumed`), issue a new one — never reuse.

Registered but wrong space? Remove the membership (`DELETE /members/:userId`) and send a fresh invite for the right space; the user keeps their account and passkey and joins via path (B).

## 3. Recovery

**The last owner lost access (all passkeys gone) but a member remains** — promote the member, then let the old owner re-register through a new invite from the promoted member:

```sql
UPDATE space_members SET role = 'owner' WHERE space_id = '<space-uuid>' AND user_id = '<member-uuid>';
```

**Nobody can log in** (single user, all passkeys gone): follow the passkey skill's recovery — re-enable `INITIAL_REGISTRATION_TOKEN` temporarily, register a new user, then attach the new user to the existing space by SQL instead of letting bootstrap create a second empty space:

```sql
INSERT INTO space_members (space_id, user_id, role, created_at)
VALUES ('<existing-space-uuid>', '<new-user-uuid>', 'owner', '<iso-now>');
DELETE FROM spaces WHERE id = '<the-empty-space-bootstrap-just-created>';  -- cascades its membership
```

**Owner promotion / demotion in general** is SQL until a second owner is a recurring need; the `isLastOwner` guard only protects `DELETE /members`, so when demoting by SQL check `SELECT COUNT(*) FROM space_members WHERE space_id = ? AND role = 'owner'` first.

**Removing a member** — `DELETE /api/spaces/:spaceId/members/:userId` (owner). Effective on the victim's next request (memberships are resolved per request). Their `created_by` rows stay, attributed to them.

**Deleting a user entirely** — `DELETE FROM users WHERE id = ?` cascades `credentials`, `sessions`, `space_members`, their issued `invites`; `created_by` / `consumed_by_user_id` become NULL. This only works because every audit FK is `ON DELETE SET NULL` — with the SQLite default it fails on the first meal they logged.

## 4. Cleanup (optional Cron)

```sql
-- expired, never used: nothing to audit
DELETE FROM invites WHERE consumed_at IS NULL AND expires_at < '<iso-now>';
-- consumed long ago: keep 90 days of "who joined through what" then drop
DELETE FROM invites WHERE consumed_at IS NOT NULL AND consumed_at < '<iso-now-minus-90d>';
```

Wire it as a pure function + boundary in the `scheduled` handler (`cloudflare-cron-to-discord` shows the shape); at family scale it can also just never run.

## 5. Audit queries

```sql
-- who is in which space, with role
SELECT s.name AS space, u.display_name, sm.role, sm.created_at
FROM space_members sm JOIN spaces s ON s.id = sm.space_id JOIN users u ON u.id = sm.user_id
ORDER BY s.name, sm.created_at;

-- spaces with no owner (should be empty — the last-owner guard exists for this)
SELECT s.id, s.name FROM spaces s
WHERE NOT EXISTS (SELECT 1 FROM space_members sm WHERE sm.space_id = s.id AND sm.role = 'owner');

-- pending invites
SELECT id, space_id, expires_at, created_by_user_id FROM invites
WHERE consumed_at IS NULL AND expires_at > '<iso-now>';

-- orphan check after any manual SQL: parent rows whose space is gone (should be empty; CASCADE makes it so)
SELECT COUNT(*) FROM meals m WHERE NOT EXISTS (SELECT 1 FROM spaces s WHERE s.id = m.space_id);
```
