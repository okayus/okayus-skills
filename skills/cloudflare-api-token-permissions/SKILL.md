---
name: cloudflare-api-token-permissions
description: Map a Cloudflare CI deploy auth error (code 10000 / 7403 / 9106) to the missing API token permission, and show how to extend the token in-place without regenerating its value (so the GitHub Secret stays untouched). Use when `wrangler deploy` or `wrangler d1 migrations apply` fails in GitHub Actions with `Authentication error`, or when adding a new binding (`r2_buckets` / `kv_namespaces` / `queues` / `vectorize` / `hyperdrive`) to `wrangler.jsonc` and the deploy starts failing in CI even though it works locally. Covers the permission matrix per binding, the "Edit Cloudflare Workers" template's silent omission of D1 / Queues / Vectorize, and the diagnostic flow when multiple permissions are missing.
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets any project that uses `wrangler deploy` via GitHub Actions with a Cloudflare account-level API Token in the `CLOUDFLARE_API_TOKEN` secret.
metadata:
  author: okayus
  version: "0.1.0"
---

# Cloudflare API Token Permissions

When `wrangler deploy` (or `wrangler d1 migrations apply`) fails in CI with `code: 10000`, `code: 7403`, or `code: 9106`, the cause is **almost always: the GitHub Secret `CLOUDFLARE_API_TOKEN` is missing a permission for a binding or operation that `wrangler.jsonc` references**.

Adding a binding to `wrangler.jsonc` doesn't fail locally (your `wrangler login` session has full account access), but CI's narrow API token does. The error surfaces only when CI runs — typically after the PR is already merged.

## When to use this skill

- A CI `wrangler deploy` job that previously succeeded now fails with `Authentication error [code: 10000]` / `[code: 7403]` / `[code: 9106]`
- You're about to add a binding (`r2_buckets`, `kv_namespaces`, `queues`, `vectorize`, `hyperdrive`, `ai`, `browser`) to `wrangler.jsonc` and want to predict whether the token needs an extension
- Token rotation: the secret value leaked or expired and needs replacement
- You used the **`Edit Cloudflare Workers` template** to create a token and need to verify what's actually included (it omits D1 / Queues / Vectorize — see below)

## Error code → missing permission

| First error in deploy log | Cloudflare API path that failed | Missing permission |
|---|---|---|
| `Authentication error [code: 10000]` | `/accounts/<id>/r2/buckets/<name>` | `Account / Workers R2 Storage / Edit` |
| `not authorized [code: 7403]` | `/accounts/<id>/d1/database/<id>/query` | `Account / D1 / Edit` |
| `Authentication failed [code: 9106]` | `/memberships` | `Account / Account Settings / Read` (typically a follow-on after the first failure) |
| `Authentication error [code: 10000]` | `/accounts/<id>/workers/scripts/<name>` | `Account / Workers Scripts / Edit` |
| `Authentication error [code: 10000]` | `/accounts/<id>/storage/kv/namespaces/<id>` | `Account / Workers KV Storage / Edit` |
| `Authentication error [code: 10000]` | `/accounts/<id>/queues/<id>` | `Account / Queues / Edit` |

**The first error in the log is the actionable one**; subsequent errors (especially `code: 9106` on `/memberships`) are usually consequences of the first failed auth call. Fix the first one and the rest disappear.

## Permission matrix (binding / command → required permission)

| Binding or wrangler command | Required token permission |
|---|---|
| `wrangler deploy` core (Worker upload) | `Account / Workers Scripts / Edit` |
| `wrangler d1 migrations apply --remote` | `Account / D1 / Edit` |
| `wrangler d1 export --remote` (backup) | `Account / D1 / Edit` (Read may suffice; Edit is the safe pick) |
| `r2_buckets` binding (existence check on deploy) | `Account / Workers R2 Storage / Edit` |
| `kv_namespaces` binding | `Account / Workers KV Storage / Edit` |
| `queues.producers` / `queues.consumers` binding | `Account / Queues / Edit` |
| `vectorize` binding | `Account / Vectorize / Edit` |
| `hyperdrive` binding | `Account / Hyperdrive / Edit` |
| `ai` (Workers AI) binding | `Account / Workers AI / Read` |
| `browser` (Browser Rendering) binding | `Account / Browser Rendering / Edit` |
| Memberships lookup (wrangler boilerplate) | `Account / Account Settings / Read` |

For the typical small-app stack (SPA + API + D1 + R2 served from one Worker), the **minimum** token permission set is:

- `Account / Workers Scripts / Edit`
- `Account / D1 / Edit`
- `Account / Workers R2 Storage / Edit`
- `Account / Account Settings / Read`
- Account Resources: `<your specific account>` (don't grant *All accounts* unless you have a reason)

## The "Edit Cloudflare Workers" template trap

Cloudflare offers a one-click template named **`Edit Cloudflare Workers`**. It looks complete but **silently omits D1, Queues, and Vectorize** — products added after the template was originally set. (The template does get occasional refreshes — R2 is included nowadays — so re-verify against the [template reference](https://developers.cloudflare.com/fundamentals/api/reference/template/) when in doubt.)

What the template includes (verified 2026-08-07):

- `Workers Scripts / Edit`
- `Workers KV Storage / Edit`
- `Workers R2 Storage / Edit`
- `Workers Tail / Read`
- `Workers Routes / Edit`
- `Account Settings / Read`
- `User Details / Read` (User scope)
- `Memberships / Read` (User scope)

What you must add manually if your `wrangler.jsonc` uses them:

- `D1 / Edit`
- `Queues / Edit`
- `Vectorize / Edit`
- `Hyperdrive / Edit`

**Recommendation**: skip the template. Use **`Create Custom Token`** and pick exactly what you need from the matrix above. Faster than auditing the template's gaps.

## In-place permission edit (keeps the token value)

A common misconception: editing a Cloudflare API Token's permissions regenerates its value, requiring a GitHub Secret update.

**It doesn't.** Cloudflare keeps the same token value when you edit permissions; only **rotating** (deleting + recreating) generates a new value.

Workflow:

1. https://dash.cloudflare.com/profile/api-tokens
2. Locate the token used by GitHub Actions (sort by *Last Used* — CI tokens are touched on every `main` push)
3. Click **Edit** (not "Roll")
4. Add the missing permission row → **Continue to summary** → **Update Token**
5. Token value unchanged → **no GitHub Secret update needed**
6. Re-run the failed CI: `gh run rerun <run-id> --failed`

## Identifying which token is the CI token

If you have multiple tokens in your account and aren't sure which value lives in `CLOUDFLARE_API_TOKEN`:

- The GitHub Secret value is one-way encrypted — not retrievable
- `gh secret list -R <owner>/<repo>` only shows the `updatedAt` timestamp; correlate with the Cloudflare token's *Created* / *Last Used* timestamps
- Cloudflare dashboard sorts tokens by *Last Used*. The most-recently-used should be the CI token (Actions runs on every `main` push)
- If you can't tell, **rotate**: create a fresh token with the full matrix, `gh secret set CLOUDFLARE_API_TOKEN`, delete the old one. Avoids a long bisect.

## Diagnostic flow when CI deploy fails

1. `gh run view <run-id> --log-failed` → find the **first** `[ERROR] code: <number>` line
2. Look up the code in the *Error code → missing permission* table above
3. Edit the token's permissions in-place (value stays the same)
4. `gh run rerun <run-id> --failed`
5. If a **new** `code: <different number>` appears, repeat from step 2 (cumulative permissions across the deploy stages — e.g. R2 binding check fails first → fix R2 → D1 migrations apply fails next → fix D1)
6. If the **same** code persists, check that the token you edited is actually the one in `CLOUDFLARE_API_TOKEN` (see *Identifying which token is the CI token* above) — most common cause of "I added the permission but it still fails"

## When you do need to rotate (regenerate)

- The secret value leaked publicly
- Cloudflare flagged the token as compromised
- The token expired (if you set a TTL when creating)
- You can't tell which token the CI uses (rotate to break the ambiguity)

In that case:

1. Create a new token with the full permission matrix above (Custom Token, not the template)
2. Copy the new value (shown once)
3. Update the GitHub Secret: `gh secret set CLOUDFLARE_API_TOKEN -R <owner>/<repo>` and paste the value
4. Delete the old token in the Cloudflare dashboard (avoids accumulation of stale tokens)
5. Re-run the failed CI

## What this skill does NOT cover

- **Local `wrangler login` session permissions** — `wrangler login` uses OAuth and grants full account access; it never has the narrow-permission problem. Only CI tokens hit this.
- **R2 bucket-scoped object access tokens** (S3-compatible API): those are a different token type (created under R2 → Manage R2 API Tokens) and unrelated to CI deploy. Workers R2 Storage *binding* uses the account API token, not the bucket-scoped one.
- **Deploying via `wrangler deploy --account-id <id>`** instead of via secret: same permission requirements, just authenticated differently.

## Related skills

- [`cloudflare-workers-deploy-skeleton`](../cloudflare-workers-deploy-skeleton/SKILL.md) — initial project setup. The token created during that skill should already follow this matrix from day 1; consult this skill when adding new bindings later.
- [`cloudflare-d1-drizzle-migration`](../cloudflare-d1-drizzle-migration/SKILL.md) — D1 migration pitfalls (`PRAGMA foreign_keys=OFF` ignored). Needs `D1 / Edit`.
- [`cloudflare-d1-weekly-backup-via-pr`](../cloudflare-d1-weekly-backup-via-pr/SKILL.md) — weekly D1 backup workflow. Reuses the same `CLOUDFLARE_API_TOKEN` (no new token needed if the matrix is met).
- [`cloudflare-workers-builds-keyless-deploy`](../cloudflare-workers-builds-keyless-deploy/SKILL.md) — the alternative that removes this whole problem class: deploy via Workers Builds with **no** Cloudflare token in GitHub at all. Its default build token has the same flavor of trap (D1 Edit missing).
