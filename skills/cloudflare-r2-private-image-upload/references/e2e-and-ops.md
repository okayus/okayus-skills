# e2e, local R2 inspection, orphan sweep, backup workflow, runbook

## e2e — extend the golden path, don't add a suite

Per `cloudflare-workers-e2e-playwright` the suite stays at golden path + authorization boundary + security headers. Upload fits inside the golden path; the cross-user 404 fits the authorization-boundary spec. Sessions come from the virtual authenticator or the seeded-session seam of that skill; the second user (`OTHER`) is seeded by `global-setup.ts` exactly like nyalog's cross-space fixture.

### Fixture

An 8×8 red PNG (74 bytes). Headless Chromium decodes it, the client `prepareImage` produces two tiny JPEGs, and the Worker's magic-bytes check sees `FF D8 FF`:

```ts
// e2e/fixtures/png.ts
export const PNG_8x8 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR42mM4YWODFTEMLQkAZZlQAS/gME0AAAAASUVORK5CYII=",
  "base64",
);
```

### Golden-path extension

```ts
import { expect, test } from "@playwright/test";
import { PNG_8x8 } from "./fixtures/png";

test("photo: upload → visible → private → deleted", async ({ page, context, baseURL }) => {
  // ...logged in, a record created, on the record page (existing golden-path steps)

  const [res] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === "POST" && /\/attachments$/.test(r.url())),
    page.getByLabel("写真を選ぶ").setInputFiles({ name: "meal.png", mimeType: "image/png", buffer: PNG_8x8 }),
  ]);
  expect(res.status()).toBe(201);
  const { url } = (await res.json()) as { url: string };

  // The <img> actually rendered (the proxy route returned bytes the browser could decode).
  const img = page.locator(`img[src^="${url}"]`).first();
  await expect(img).toBeVisible();
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0);

  // Headers on the authenticated route.
  const direct = await page.request.get(url);
  expect(direct.status()).toBe(200);
  expect(direct.headers()["content-type"]).toBe("image/jpeg");
  expect(direct.headers()["cache-control"]).toBe("private, max-age=3600");
  expect(direct.headers()["x-content-type-options"]).toBe("nosniff");

  // Another family (seeded OTHER user) gets 404, not 403 — existence hiding.
  const other = await context.request.get(url, { headers: { Cookie: `session=${process.env.E2E_OTHER_SESSION}` } });
  expect(other.status()).toBe(404);

  // Delete → the route is gone.
  await page.getByRole("button", { name: /写真を削除/ }).click();
  await expect.poll(async () => (await page.request.get(url)).status()).toBe(404);
});
```

Adapt the cookie name/value to the seam you use (`session` over http in e2e; `__Host-session` only exists over https). A 415 case (`setInputFiles` with `{ name: "x.txt", mimeType: "text/plain", buffer: Buffer.from("nope") }`) belongs in a **unit** test of `sniffImageType` and the route, not in Playwright.

### Is the object really gone? (local R2 inspection — UNVERIFIED)

R2 emulation persists under the same state root as D1. Expected (unconfirmed) layout and commands:

```sh
# list what the local emulator holds
ls .wrangler/state/v3/r2/<bucket_name>/blobs/

# fetch one object (exit code non-zero when missing)
pnpm exec wrangler r2 object get <bucket_name>/photos/<spaceId>/<recordId>/<id> \
  --local --persist-to .wrangler/state --file /tmp/out.bin
```

Confirm both, note the wrangler version, and write the working form back here. Until then the e2e asserts the *route* is 404 and the unit test of the delete handler asserts `delete` was called with both keys (mock the bucket).

### Sandbox

Nothing R2-specific changes inside `claude-code-docker-sandbox`: the bucket is local, no credentials, no egress. The only binding that breaks credential-free dev is AI (nyalog keeps a `wrangler.local.jsonc` without it). See `playwright-e2e-in-docker-sandbox` for the browser bake and the `--ip 127.0.0.1` rule.

## Orphan sweep (optional weekly cron)

Orphans appear only from the compensating-delete path failing or a parent delete crashing between the R2 and the D1 step. At family scale they cost nothing; a sweep is hygiene, not correctness. Cron plumbing per `cloudflare-cron-to-discord`.

```ts
// worker/cron/sweep-orphans.ts — pure function over (objects, knownKeys, now) is unit-testable;
// the boundary does list/delete.
const GRACE_MS = 60 * 60 * 1000; // an upload whose INSERT hasn't committed yet is not an orphan

export async function sweepOrphans(env: Bindings): Promise<{ deleted: string[] }> {
  const db = drizzle(env.DB);
  const rows = await db.select({ k: attachments.r2Key, t: attachments.thumbKey }).from(attachments);
  const known = new Set(rows.flatMap((r) => (r.t ? [r.k, r.t] : [r.k])));

  const deleted: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.PHOTOS_BUCKET.list({ prefix: "photos/", cursor, limit: 1000 });
    const now = Date.now();
    const orphans = page.objects
      .filter((o) => !known.has(o.key) && now - o.uploaded.getTime() > GRACE_MS)
      .map((o) => o.key);
    if (orphans.length > 0) {
      await env.PHOTOS_BUCKET.delete(orphans); // array form, ≤ 1,000 keys per call
      deleted.push(...orphans);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { deleted };
}
```

Variants created by the Images-binding path (`<key>/w640`) are *not* in `known` — either add them to the row, or treat any key that starts with a known key + `/` as owned (`[...known].some((k) => key.startsWith(k + "/"))`).

## Backup workflow sketch (only if the ADR chose "sync")

Never run in the source projects — UNVERIFIED end to end; one successful dry run is required before trusting it.

1. Create an R2 **API token** (not an account API token): Dashboard → R2 → Manage R2 API Tokens → Object Read on the live bucket, Object Read & Write on the backup bucket. Save the Access Key ID / Secret Access Key as repo secrets
2. The S3 endpoint is `https://<account_id>.r2.cloudflarestorage.com`

```yaml
# .github/workflows/r2-backup.yml (sketch)
name: r2-backup
on:
  schedule:
    - cron: "0 18 * * 0" # Sunday 03:00 JST — cron is UTC, see cloudflare-d1-weekly-backup-via-pr
  workflow_dispatch:
jobs:
  sync:
    runs-on: ubuntu-latest
    steps:
      - run: curl -fsSL https://rclone.org/install.sh | sudo bash
      - run: rclone sync r2:<app>-photos r2:<app>-photos-backup --checksum --stats-one-line
        env:
          RCLONE_CONFIG_R2_TYPE: s3
          RCLONE_CONFIG_R2_PROVIDER: Cloudflare
          RCLONE_CONFIG_R2_ENDPOINT: https://${{ secrets.CF_ACCOUNT_ID }}.r2.cloudflarestorage.com
          RCLONE_CONFIG_R2_ACCESS_KEY_ID: ${{ secrets.R2_BACKUP_ACCESS_KEY_ID }}
          RCLONE_CONFIG_R2_SECRET_ACCESS_KEY: ${{ secrets.R2_BACKUP_SECRET_ACCESS_KEY }}
```

`sync` mirrors deletions too — a deleted photo disappears from the backup on the next run. If the point of the backup is to survive *accidental* deletes, use `rclone copy` (additive) and a bucket lock or lifecycle rule on the backup bucket instead. Restore is the same command with the remotes swapped, followed by a D1 restore from the matching weekly export.

## Runbook

| Symptom | Cause | Fix |
|---|---|---|
| `Authentication error [code: 10000]` on `/accounts/<id>/r2/buckets/<name>` in CI / Workers Builds | deploy token lacks `Account / Workers R2 Storage / Edit` | extend the token in place (`cloudflare-api-token-permissions`); for Workers Builds swap the custom build token in Settings → Build (`cloudflare-workers-builds-keyless-deploy`) |
| Deploy says the bucket does not exist | binding references a bucket never created | `pnpm exec wrangler r2 bucket create <name>` on the host |
| Upload 201 in `vite dev`, image 404 in `wrangler dev` / e2e | two `.wrangler/state` roots | `--persist-to .wrangler/state` on every wrangler invocation (`cloudflare-workers-e2e-playwright`) |
| 500 on upload, log shows a `formData` parse error | non-multipart body reached `c.req.formData()` | the `Content-Type` guard returns 400 before parsing |
| `TS2358` on `instanceof File` | worker tsconfig lib | narrow by excluding `null` / `string` |
| Android shows a broken image for a photo an iPhone uploaded | HEIC reached the server | server 415 + client message; check the `accept` attribute and the iOS transcoding behaviour (UNVERIFIED) |
| Photos sideways | orientation not applied at decode | `imageOrientation: "from-image"`, or the `<img>`-decode fallback |
| Browser hangs or truncates an image | `Content-Length` from the DB ≠ object size | `obj.size` |
| Thumbnails 500 on the Free plan after a burst of new photos | 5,000 unique transformations exhausted (`9422`) | fall back to the full image; cache variants; prefer client-side thumbs |
| A row exists, `get` returns `null` | object deleted outside the app (dashboard, sweep bug) | route returns 404 + `console.error`; reconcile with the sweep in reverse (rows without objects) |
