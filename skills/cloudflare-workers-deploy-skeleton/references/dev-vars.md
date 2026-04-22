# `.dev.vars.example` pattern

`.dev.vars` is the Workers-native way to inject secrets and env vars during `vite dev` / `wrangler dev`. Keys only in `.example` (committed), values only in `.dev.vars` (gitignored).

## `packages/web/.dev.vars.example`

```
# Copy to .dev.vars and fill values. .dev.vars is gitignored.

# JWT signing key (later phase, not needed at skeleton)
SESSION_SECRET=

# WebAuthn Relying Party (localhost for dev; prod uses wrangler.jsonc vars)
RP_ID=localhost
ORIGIN=http://localhost:5173

# Discord Webhook URL (needed for cron-to-discord skill; skeleton alone doesn't need it)
DISCORD_WEBHOOK_URL=
```

Add keys as you introduce them. This file is a spec of "what secrets this project expects," so keep it current.

## `.gitignore` entry

Root `.gitignore` or `packages/web/.gitignore`:

```gitignore
packages/web/.dev.vars
# or globally:
.dev.vars
```

Confirm it's working:

```bash
git check-ignore packages/web/.dev.vars
# Expected: outputs `packages/web/.dev.vars` (meaning it's ignored)
# Empty output = not ignored = DANGER, fix before committing anything
```

## Creating `.dev.vars` for local development

```bash
cd packages/web
cp .dev.vars.example .dev.vars
# Edit .dev.vars to fill in real dev values
```

**Never commit `.dev.vars`.** Never paste its contents in chat, PRs, or shared docs. If it contains webhook URLs or API tokens, leaking the file is equivalent to leaking those credentials.

## Production secrets go to `wrangler secret put`

`.dev.vars` is **dev only**. For production Worker env:

```bash
pnpm --filter @<scope>/web exec wrangler secret put SESSION_SECRET
# Paste the value at the prompt

pnpm --filter @<scope>/web exec wrangler secret put DISCORD_WEBHOOK_URL
# Paste the value at the prompt
```

View what's set (names only, values are never exposed):

```bash
pnpm --filter @<scope>/web exec wrangler secret list
```

Delete:

```bash
pnpm --filter @<scope>/web exec wrangler secret delete <NAME>
```

## `vars` vs `secret` in `wrangler.jsonc`

| Thing | Location | Example |
|---|---|---|
| Non-sensitive config | `wrangler.jsonc` → `vars` (visible in git) | `RP_ID`, `ORIGIN` |
| Sensitive values | `wrangler secret put` (encrypted, invisible after write) | `SESSION_SECRET`, `DISCORD_WEBHOOK_URL`, API keys |

Both show up in `c.env.*` in the Worker. Hono's `<{ Bindings: Bindings }>` type declaration covers both uniformly — define everything in `worker/types.ts`.

## Dev-only bypass flags

For things like `DEV_BYPASS_USER_ID` that should *never* work in production, code guards them:

```ts
function isLocalOrigin(origin: string): boolean {
  return origin.startsWith("http://localhost:") || origin === "http://127.0.0.1";
}

if (env.DEV_BYPASS_USER_ID && isLocalOrigin(env.ORIGIN)) {
  // Only honors bypass when ORIGIN is local.
}
```

This prevents an accidental `wrangler secret put DEV_BYPASS_USER_ID` on prod from silently weakening auth.
