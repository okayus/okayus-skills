# Pitfalls that eat hours

Known setup traps in order of frequency-of-hitting. Each has a symptom and a fix.

## 1. `pnpm deploy` collides with pnpm built-in

**Symptom**: `pnpm deploy` in the workspace root does something surprising — copies files, prints "publishing package," etc. — but doesn't run your `wrangler deploy` script. Or it fails mysteriously.

**Cause**: `pnpm deploy` is a [built-in pnpm subcommand](https://pnpm.io/cli/deploy) for deploying a subset of a workspace. It shadows your npm-script `deploy`.

**Fix**: In the root `package.json`, always use `run`:

```json
"scripts": {
  "deploy": "pnpm --filter @<scope>/web run deploy"
  //                                    ^^^ keep this word
}
```

In CI:

```yaml
run: pnpm --filter @<scope>/web run deploy
```

Inside the package itself (`packages/web/package.json`), `"deploy": "pnpm build && wrangler deploy"` is fine because `pnpm run deploy` explicitly runs the script.

## 2. "Edit Cloudflare Workers" API token template lacks `D1:Edit`

**Symptom**: GitHub Actions fails on the D1 migrations step. Log shows something like:

```
✘ [ERROR] A request to the Cloudflare API (/.../d1/database/.../migrations) failed.
Code: 7403
```

**Cause**: Cloudflare's "Edit Cloudflare Workers" token template — the obvious one to pick when generating an API token — grants `Workers Scripts:Edit` but not `D1:Edit`. `wrangler deploy` succeeds, but `wrangler d1 migrations apply --remote` can't touch D1.

**Fix**: When creating the API token, after picking the template, add the D1 permission manually:

- Account → D1 → Edit

Final permissions must include all four:
- Account → Workers Scripts → Edit
- Account → **D1 → Edit** ← this is the add-on
- Account → Account Settings → Read
- User → User Details → Read

Update the `CLOUDFLARE_API_TOKEN` secret in GitHub:

```bash
gh secret set CLOUDFLARE_API_TOKEN --body "<new-token>"
```

## 3. `database_id` placeholder left in `wrangler.jsonc`

**Symptom**: `wrangler deploy` fails with:

```
✘ [ERROR] Could not resolve database '<...>'
```

Or migrations apply succeeds on a nonexistent DB (unlikely but possible if `<...>` happens to coincidentally look like a UUID — near-zero probability).

**Cause**: You substituted placeholders in templates except for `database_id`, or the template was shared with `<...>` markers.

**Fix at the source**: After `wrangler d1 create`, immediately substitute the output UUID into `wrangler.jsonc`. Before committing any work, grep for placeholders:

```bash
grep -E '<[^>]+>' packages/web/wrangler.jsonc
# Expected: zero lines
```

If `database_id` is already wrong in prod, fix locally and re-deploy. Data in the old DB (if any) stays in the old DB — you'd have to migrate manually if there was anything there.

## 4. `RP_ID` changed after passkey registration → every credential invalidates

**Symptom**: Users who registered passkeys suddenly can't log in. Chrome/Safari returns "credential not found" or "operation not supported." No server-side error.

**Cause**: WebAuthn credentials are bound to the Relying Party ID (the hostname). Changing `RP_ID` from `oldname.workers.dev` to `newname.workers.dev` (or to a custom domain) invalidates every credential ever registered for the old RP_ID.

**Prevention**: Lock `RP_ID` on first deploy, treat it as permanent. If uncertain about domain, **use a custom domain from day 1**, not the `workers.dev` subdomain — because you can always point a custom domain somewhere else, but `workers.dev` subdomains are tied to your Cloudflare account name.

**Recovery if changed**: There's no recovery other than asking every user to re-register. Document the RP_ID lock-in date in an ADR (`docs/adr/0001-rp-id-lock-in.md`) to avoid future confusion.

## 5. `@cloudflare/vite-plugin@0.1.x` doesn't route `/__scheduled` in dev

**Symptom**: `curl "http://localhost:5173/__scheduled?cron=<expr>"` returns 200 but the body is SPA HTML (`<h1>...</h1>`) instead of running the `scheduled` handler. No `[cron] fired at ...` log appears.

**Cause**: The plugin's 0.1.x dev server doesn't implement the `/__scheduled` endpoint for local Cron testing. Requests to `/__scheduled` fall through to the SPA fallback.

**Workaround options**:

a. **Skip local Cron testing** entirely. Verify via `wrangler tail` after prod deploy. This is fine for skeleton-phase verification — the domain logic is tested via vitest unit tests, and the Cron wiring is identical between dev and prod
b. **Bump to `@cloudflare/vite-plugin@1.x`**, which implements `/__scheduled`. This requires `wrangler@^4` (major breaking change), so do it deliberately
c. **Trigger from Dashboard** → Workers & Pages → your-worker → Triggers → "Send event" / "Run now" on the Cron row (UI label varies by release)

See the sibling `cloudflare-cron-to-discord` skill for detailed coverage of this issue.

## 6. Migrations dir empty → "Migrations directory is empty" error

**Symptom**: `wrangler d1 migrations apply` emits:

```
✘ [ERROR] Migrations directory is empty.
```

**Cause**: `drizzle/` exists but no `.sql` files. Usually because `0000_init.sql` wasn't committed.

**Fix**:

```bash
git ls-files packages/web/drizzle
# Expected: at least one .sql file
```

If empty, create `0000_init.sql` per `d1-scaffold.md`. Commit and push.

## 7. `wrangler@3.x` vs `wrangler@4.x` command renames

**Symptom**: Suddenly-working command is suddenly broken after a dependency update:

```
✘ [ERROR] `wrangler deployments view <deployment-id>` has been renamed 
          `wrangler versions view [version-id]`. Please use that command instead.
```

**Cause**: `wrangler@4.x` renamed several subcommands. Script / doc snippets written for 3.x don't work as-is.

**Fix**: Either:
- Update the script to use the new name (`wrangler versions view`)
- Or pin your wrangler version in `package.json` (`"wrangler": "^3.100.0"`)

If you have multiple people using different wrangler versions, pin it in `package.json` and run via `pnpm exec wrangler` (not globally installed wrangler).

## 8. `concurrency: cancel-in-progress: true` creates mid-deploy inconsistency

**Symptom**: Fast successive pushes to `main`. Sometimes the DB has new migrations applied but the Worker is still old — or vice versa. Users see 500s briefly.

**Cause**: The second push cancels the first deploy mid-run. The first deploy may have applied migrations but not yet uploaded the Worker (or vice versa). Partial state is worse than sequenced state.

**Fix**: Use `cancel-in-progress: false` in the workflow's `concurrency` block:

```yaml
concurrency:
  group: deploy-${{ github.ref }}
  cancel-in-progress: false
```

Each deploy completes end-to-end, then the next starts. Worst case: longer queue. Never: inconsistent state.

## 9. Forgetting `.dev.vars` isn't production

**Symptom**: You set `DISCORD_WEBHOOK_URL=<dev webhook>` in `.dev.vars`, work locally, push, deploy, and prod goes silent. Or the reverse — `.dev.vars` has a prod URL somehow and dev accidentally hits prod.

**Cause**: `.dev.vars` is dev-only. Production secrets need `wrangler secret put <NAME>`. Mixing them is easy because the binding interface is identical in code.

**Fix**: Establish a naming discipline early. For example, Discord webhooks: create webhooks named exactly `routine-tasks (dev)` and `routine-tasks (prod)` so that if a message arrives in the wrong channel, you can tell from the sender name. See the `cloudflare-cron-to-discord` skill for the full pattern.

Make sure:
- `.dev.vars` is in `.gitignore`
- `.dev.vars.example` is committed, with keys only
- Production secrets via `wrangler secret put` only, never in `.dev.vars` or `wrangler.jsonc`
