# e2e: the authorization-boundary spec

One spec proves the whole model: an authenticated user cannot see a space they are not a member of, and the server says **404 with the exact body** — not 403, not 500. Playwright wiring (`wrangler dev` against the build, `--persist-to`, virtual authenticator, seeded-session seam, `--local`-only helpers) is in `cloudflare-workers-e2e-playwright`; only the seed and the spec body are here.

## Seed: an "other family" with fixed UUIDs

```ts
// e2e/global-setup.ts
import { execSync } from "node:child_process";

// Fixed ids so specs can hit them directly. INSERT OR IGNORE keeps the setup idempotent
// across runs; the order is the FK order (D1 enforces foreign keys).
export const OTHER_USER_ID = "00000000-0000-4000-8000-000000000099";
export const OTHER_SPACE_ID = "00000000-0000-4000-8000-000000000098";
export const OTHER_MEAL_ID = "00000000-0000-4000-8000-000000000097";

export default async function globalSetup() {
  const t = "2026-01-01T00:00:00.000Z";
  const seed = [
    `INSERT OR IGNORE INTO users(id, display_name, created_at) VALUES ('${OTHER_USER_ID}', 'other', '${t}');`,
    `INSERT OR IGNORE INTO spaces(id, name, created_at) VALUES ('${OTHER_SPACE_ID}', 'other family', '${t}');`,
    `INSERT OR IGNORE INTO space_members(space_id, user_id, role, created_at) VALUES ('${OTHER_SPACE_ID}', '${OTHER_USER_ID}', 'owner', '${t}');`,
    `INSERT OR IGNORE INTO meals(id, space_id, name, eaten_at, created_by, created_at, updated_at) VALUES ('${OTHER_MEAL_ID}', '${OTHER_SPACE_ID}', 'other-meal', '${t}', '${OTHER_USER_ID}', '${t}', '${t}');`,
  ].join(" ");

  // --local is hardcoded on purpose: this must never be able to touch the remote D1.
  execSync(`pnpm exec wrangler d1 execute <db-name> --local --command "${seed}"`, { stdio: "inherit" });
}
```

If your e2e server runs with `--persist-to .wrangler/state`, the seed must target the same state directory (the `wrangler dev --config` quirk in the e2e skill) — otherwise the spec hits an empty database and fails with a misleading 500 instead of a 404.

## Spec (passkey app)

```ts
// e2e/authorization-boundary.spec.ts
import { expect, test } from "@playwright/test";
import { enableVirtualAuthenticator } from "./helpers/webauthn"; // e2e skill
import { OTHER_MEAL_ID, OTHER_SPACE_ID } from "./global-setup";

test("a member of space A gets 404 for space B (API and UI)", async ({ page }) => {
  await enableVirtualAuthenticator(page);

  // 1. Become a real user of a real space (initial-token registration bootstraps one space).
  await page.goto("/");
  await page.getByLabel(/registration token/i).fill(process.env.E2E_INITIAL_REGISTRATION_TOKEN!);
  await page.getByLabel(/display name/i).fill("e2e-stranger");
  await page.getByRole("button", { name: /register passkey/i }).click();
  await page.waitForURL(/#\/spaces\/[0-9a-f-]{36}/, { timeout: 15_000 });

  // 2. API: the other family's space is indistinguishable from a non-existent one.
  const list = await page.request.get(`/api/spaces/${OTHER_SPACE_ID}/meals`);
  expect(list.status()).toBe(404);
  expect(await list.json()).toEqual({ error: { type: "not_found" } });

  const one = await page.request.get(`/api/spaces/${OTHER_SPACE_ID}/meals/${OTHER_MEAL_ID}`);
  expect(one.status()).toBe(404);

  // 3. A write attempt is also 404 (not 403, not 500).
  const write = await page.request.post(`/api/spaces/${OTHER_SPACE_ID}/meals`, {
    data: { name: "intruder", eatenAt: "2026-01-02T00:00:00.000Z" },
  });
  expect(write.status()).toBe(404);

  // 4. UI: the SPA shows its access-denied view for the foreign space.
  await page.goto(`/#/spaces/${OTHER_SPACE_ID}`);
  await expect(page.getByText(/access denied|アクセス権がありません/)).toBeVisible();
});
```

Asserting `toEqual` on the body catches the classic regression where a handler starts returning `{ error: { type: "space_not_found" } }` or a Drizzle error leaks as 500.

## Spec (OAuth app)

Same assertions; replace step 1 with the seeded-session seam from the e2e skill: seed a session row for a user who is a member of space A, `context.addCookies([...])` with that token, and hit space B. Switching the cookie to the OTHER user's token mid-test and expecting 200 proves the 404 is membership-driven, not a broken route.

## What stays out of e2e

- Invite issue → accept → member appears: unit-test `validateInvite` (expired / consumed / unknown) and the `registerInvitedUser` batch ordering with a fake `D1Database` whose `batch` returns `meta.changes: 0` for the UPDATE; run the real flow once by hand on a phone. If the virtual authenticator is already wired, one extra golden-path spec "owner issues invite → second browser context registers through it → appears in `/members`" is worth it; keep the total within the e2e skill's ≤ 6-spec budget.
- Last-owner guard, rename, revoke: unit tests.
