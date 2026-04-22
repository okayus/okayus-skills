# Setup order

End-to-end sequence to go from empty repo to `main push → prod /health 200`. User-interactive steps (browser / secret input) are called out; everything else is agent-executable.

## Phase 1. User-interactive prerequisites

### 1.1. Wrangler login (browser)

```bash
cd <project-root>
npx -y wrangler@latest login
```

Authorizes in a browser. Done when terminal shows `Successfully logged in.`

### 1.2. Create the D1 database

```bash
npx -y wrangler@latest d1 create <db-name>
```

Copy the `database_id` UUID from the output. You will paste it into `wrangler.jsonc` in Phase 2.

### 1.3. Create Cloudflare API token for GitHub Actions

1. Cloudflare Dashboard → top-right avatar → **My Profile** → **API Tokens** → **Create Token**
2. Start from **"Edit Cloudflare Workers"** template
3. **ADD** the missing `D1:Edit` permission (the template omits it — without it, `wrangler d1 migrations apply --remote` fails with 7403 in CI)
4. Final permissions:
   - Account → Workers Scripts → Edit
   - Account → D1 → Edit
   - Account → Account Settings → Read
   - User → User Details → Read
5. Continue to summary → Create Token → **copy the token once** (it's never shown again)
6. Copy the Account ID from the Dashboard right sidebar

### 1.4. Add GitHub secrets

```bash
gh secret set CLOUDFLARE_API_TOKEN --body "<token from 1.3>"
gh secret set CLOUDFLARE_ACCOUNT_ID --body "<account id from 1.3>"
```

## Phase 2. Agent-executable scaffold

### 2.1. Workspace root

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
```

Create root `package.json`:

```json
{
  "name": "<project-name>",
  "private": true,
  "scripts": {
    "dev": "pnpm --filter @<scope>/web dev",
    "build": "pnpm --filter @<scope>/web build",
    "deploy": "pnpm --filter @<scope>/web run deploy",
    "check": "pnpm --filter @<scope>/web check",
    "db:migrate": "pnpm --filter @<scope>/web db:migrate",
    "db:migrate:prod": "pnpm --filter @<scope>/web db:migrate:prod"
  },
  "packageManager": "pnpm@9.15.0",
  "engines": { "node": ">=22" }
}
```

**Why explicit `run`** for `deploy`: `pnpm deploy` is a built-in pnpm subcommand and collides with npm-script `deploy`. Always use `run deploy` in the root's filtered version.

### 2.2. `packages/web/` layout

Create these directories and files using the templates:

- `packages/web/package.json` — see [wrangler-template.md](wrangler-template.md)
- `packages/web/wrangler.jsonc` — see [wrangler-template.md](wrangler-template.md). **Substitute the real `database_id` UUID from Phase 1.2 immediately**
- `packages/web/vite.config.ts` + `tsconfig.json` — see [tsconfig-and-vite.md](tsconfig-and-vite.md)
- `packages/web/index.html` + `src/main.tsx` + `src/App.tsx` — minimal React entry (any `<h1>` in App.tsx)
- `packages/web/worker/{index,cron,types}.ts` — see [worker-template.md](worker-template.md)
- `packages/web/drizzle/0000_init.sql` — see [d1-scaffold.md](d1-scaffold.md)
- `packages/web/.dev.vars.example` — see [dev-vars.md](dev-vars.md)
- `packages/web/.gitignore` entry for `.dev.vars` (or rely on root `.gitignore`)

### 2.3. Verify `wrangler.jsonc` has no placeholders

```bash
grep -E '<[^>]+>' packages/web/wrangler.jsonc
# → should output nothing. If `<...>` remains, substitute before proceeding.
```

### 2.4. GitHub Actions workflow

Create `.github/workflows/deploy.yml` from [gh-actions-template.md](gh-actions-template.md).

### 2.5. Install and local verify

```bash
pnpm install
pnpm check      # tsc --noEmit passes
pnpm --filter @<scope>/web db:migrate   # local D1 migration applies
pnpm dev &
sleep 3
curl -s http://localhost:5173/health    # → {"status":"ok"}
curl -s http://localhost:5173/ | head -5 # → HTML containing <h1>...
kill %1
```

If `/` returns 404, consult [spa-routing-diagnosis.md](spa-routing-diagnosis.md).

### 2.6. Commit and push

```bash
git add .
git commit -m "chore: scaffold cloudflare workers skeleton"
git push -u origin <branch-name>
gh pr create --draft --title "chore: deploy skeleton" --body "..."
```

## Phase 3. User merges, first deploy runs

Once the PR is squash-merged to `main`, GH Actions auto-triggers `deploy.yml`:

```bash
gh run watch
# → ✓ deploy · Deploy · main
```

If it fails, common causes (in descending frequency):
- `database_id` still a placeholder → fix and re-push
- CF API token lacks `D1:Edit` → regenerate token per 1.3 and update secret
- `drizzle/` directory empty (no migration file) → confirm `0000_init.sql` is committed

## Phase 4. Production URL lookup and RP_ID locking

### 4.1. Find the production URL

Cloudflare Dashboard → **Workers & Pages** → `<project-name>` → **Settings** → **Triggers** → **Routes**. Typical form:

```
https://<project>.<your-cf-subdomain>.workers.dev
```

### 4.2. Lock RP_ID / ORIGIN to this URL

Edit `packages/web/wrangler.jsonc`:

```jsonc
"vars": {
  "RP_ID": "<project>.<your-cf-subdomain>.workers.dev",
  "ORIGIN": "https://<project>.<your-cf-subdomain>.workers.dev"
}
```

Commit → push → merge → re-deploy.

**Critical**: If you will ever use WebAuthn / passkeys, **this hostname is permanent**. Changing `RP_ID` later invalidates every registered credential. If in doubt, use a custom domain from day 1 instead of the `workers.dev` subdomain, since you can point a custom domain anywhere later.

## Phase 5. Verify production

```bash
HOST=https://<project>.<your-cf-subdomain>.workers.dev

curl -s "$HOST/health"        # → {"status":"ok"}
curl -si "$HOST/" | head -10  # → 200 + <h1>...
pnpm --filter @<scope>/web exec wrangler d1 migrations list <db-name> --remote
# → 0000_init (Applied)
```

Cron trigger will fire at the next scheduled time. Confirm via:

```bash
pnpm --filter @<scope>/web exec wrangler tail
# Watch for "[cron] fired at ..." at the scheduled time
```

Or in Dashboard → Triggers → Cron Triggers → "Next scheduled execution".

## Completion

All 7 criteria in the SKILL.md completion section should now be met. You have a working deploy pipeline with zero business logic; next skill / phase builds on top.
