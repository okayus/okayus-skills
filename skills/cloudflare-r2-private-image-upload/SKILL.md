---
name: cloudflare-r2-private-image-upload
description: Store user-uploaded photos in a PRIVATE Cloudflare R2 bucket and serve them through the Worker only after session + space-membership authorization, with client-side downscaling (EXIF/GPS stripped) before upload. Use when a Workers + Hono + D1 app needs image upload where photos must stay private to the family/space (no public bucket, no r2.dev URL), when an uploaded image returns 404 after switching between `vite dev` and `wrangler dev`, when `wrangler deploy` fails with `Authentication error` (code 10000) on `/r2/buckets` after adding `r2_buckets`, or when an iPhone HEIC photo won't display on Android. Covers the decision matrix with pricing verified 2026-08 (R2 free tier, Images 5,000 free transformations and the Free-plan 9422 error), the no-extension key scheme `<prefix>/<spaceId>/<parentId>/<id>`, magic-bytes validation, the authorize-before-R2 serve route with conditional GET, delete ordering, thumbnails (client variants vs Images binding cached into R2), e2e, and the no-PITR backup decision.
license: MIT
compatibility: Designed for Claude Code and similar agents. Targets Cloudflare Workers with Hono + Vite + @cloudflare/vite-plugin + Drizzle + D1 + a private R2 bucket (wrangler@^4, globals via `wrangler types`). Assumes a session middleware that sets `memberSpaceIds` (see cloudflare-workers-space-membership-invite) on top of cloudflare-workers-deploy-skeleton. Runs credential-free in a Docker sandbox because R2 is simulated locally; the optional Images binding is low-fidelity offline.
metadata:
  author: okayus
  version: "0.1.0"
---

# Private R2 image upload, served through the Worker

**Provenance**: extracted from nyalog (ADR-006 "medical images on R2 + Worker proxy", PRs #40–#42 — the attachment routes have run in production since 2026-05). Pricing and limits were re-verified against developers.cloudflare.com on **2026-08-22**; nyalog's ADR quoted a "25 GB / 5K writes" R2 free tier that was **wrong** — the real numbers are in the table below. This skill was written *ahead* of its second consumer (matatabetai meal photos), so the [Unverified claims](#unverified-claims--confirm-while-implementing-then-write-back) section lists exactly what that implementation must confirm and write back.

**Why this shape**: a family photo is private data. The moment a photo has a URL that works without a cookie (public bucket, `r2.dev`, signed URL pasted into chat) you have lost revocation. Keeping the bucket private and routing every byte through the Worker means the *same* session + space-membership check that guards the JSON API guards the pixels — and `<img src="/api/…">` on the same origin sends the session cookie for free, so nothing changes on the client, in the CSP, or in the auth model.

## When to use this skill

- Adding photo/image upload to a Workers + Hono + D1 app where the images belong to a space/family and must not be reachable without a session
- You're deciding between R2, Cloudflare Images, `/cdn-cgi/image` transformations, and presigned S3 URLs and want the 2026-08 numbers, not folklore
- Symptoms:
  - `Authentication error [code: 10000]` on `/accounts/<id>/r2/buckets/<name>` during `wrangler deploy` (or a Workers Builds build) right after adding an `r2_buckets` binding
  - An image uploaded under `vite dev` is 404 under `wrangler dev` (or in e2e) — or vice versa
  - `TS2358: The left-hand side of an 'instanceof' expression must be of type 'any'…` on `file instanceof File` in the Worker
  - A photo taken on an iPhone uploads fine but is a broken image on Android/Chrome (HEIC)
  - Portrait phone photos come out sideways after upload
- Planning thumbnails and wondering whether the Images binding will cost money (Free plan: it won't — it errors with `9422` instead)

Do **not** use for: public marketing assets (put them in the Assets binding or a public bucket), video or multi-GB objects (multipart upload, different limits), third-party direct-to-bucket uploads at scale (presigned URLs — deliberately rejected here, see the matrix), or apps without the per-space authorization model.

## Deliverables (completion criteria)

- [ ] `wrangler.jsonc` has `r2_buckets: [{ binding, bucket_name }]`; the bucket exists (`wrangler r2 bucket create`); the deploy/build token has `Account / Workers R2 Storage / Edit`
- [ ] Bucket is **private** (no public access, no `r2.dev` domain, no custom domain); every read goes through `GET /api/<parent>/:id/attachments/:attachmentId`
- [ ] Keys follow `<prefix>/<spaceId>/<parentId>/<attachmentId>` with **no extension**; content type lives in R2 `httpMetadata` **and** the D1 row
- [ ] Upload route: multipart guard → `file` narrowing → size cap (413) → **magic-bytes** allowlist (415) → `put` → INSERT, with a compensating `delete` if the INSERT throws
- [ ] Serve route: session → space membership → parent row → attachment row, **then** `get(key, { onlyIf })`; headers `Content-Type` (DB), `Content-Length` (`obj.size`), `ETag` (`obj.httpEtag`), `Cache-Control: private, max-age=3600`, `X-Content-Type-Options: nosniff`; 304 on precondition failure; 404 when the object is missing
- [ ] Delete: R2 `delete` **before** the DB delete (never the other way round); parent delete collects keys and uses the array form of `delete`
- [ ] Client downscales to ≤ 1600 px JPEG (and a 320 px thumb) via canvas before upload — EXIF/GPS gone, ~200–400 KB per photo
- [ ] HEIC policy decided and written down (default here: reject on the server with a clear message; the client converts what it can decode)
- [ ] Backup decision recorded (default: accept — the phones keep the originals; see the matrix)
- [ ] One e2e path: upload → `<img>` 200 → cross-user 404 → delete → 404
- [ ] Every `UNVERIFIED:` bullet below was confirmed or corrected in the consuming project, and this skill was updated

## The decision in one table

Numbers verified 2026-08-22 (sources and the full matrix in [references/decision-matrix.md](references/decision-matrix.md)).

| Option | Authz possible? | Cost at family scale | Verdict |
|---|---|---|---|
| **Private R2 + Worker proxy** | Yes — same middleware as the API | $0: free tier is 10 GB-month, 1M Class A, 10M Class B ops/month, egress free | **Chosen** |
| Public bucket / `r2.dev` / custom domain | No — URL = access | $0 | Rejected: private photos |
| Cloudflare Images (stored) | Signed URLs or binding | $5 per 100k stored + $1 per 100k delivered, monthly | Rejected: fixed cost for ~100 photos/month |
| `/cdn-cgi/image/...` URL transformations | No — needs a public origin | 5,000 unique transformations/month free | Unusable behind authz |
| Images **binding** (transform in the Worker) | Yes — it's just bytes in the Worker | 5,000 unique/month free; Free plan returns **error 9422** beyond that (no charge); Paid $0.50 per 1,000 | Optional thumbnail path, see below |
| Presigned S3 URLs (browser → R2 direct) | Per-URL, time-boxed | $0 but a second token type (R2 API token) | Rejected: nothing to gain at family scale |

Platform ceilings that matter: request body ≤ **100 MB** on Free/Pro (so a 10 MB app cap is a policy, not a limit); Workers Free allows **50 subrequests** per invocation.

## Wiring: binding, bucket, token, local state

```jsonc
// wrangler.jsonc (and wrangler.local.jsonc if you keep a credential-free dev config — keep them in sync)
"r2_buckets": [
  { "binding": "PHOTOS_BUCKET", "bucket_name": "<app>-photos" }
]
```

1. **Create the bucket on the host** (needs `wrangler login`; the sandbox has no credentials): `pnpm exec wrangler r2 bucket create <app>-photos` — optionally `--location apac` as a placement hint. Deploy performs an existence check, so the bucket must exist before the first deploy with the binding.
2. **Token permission**: the `r2_buckets` binding needs `Account / Workers R2 Storage / Edit` on whatever token deploys — the GH Actions `CLOUDFLARE_API_TOKEN` (matrix in `cloudflare-api-token-permissions`) **or the Workers Builds build token**. The token Workers Builds generates via *Create new token* already carries `Workers R2 Storage (edit)` (docs + dashboard notice, 2026-08-23 — see `cloudflare-workers-builds-keyless-deploy` 0.3.0); only an older or hand-made token may lack it — then extend it in place, don't regenerate. Missing it → `Authentication error [code: 10000]` on `/accounts/<id>/r2/buckets/<name>`.
3. **Local dev is fully simulated** (Miniflare) — unlike the AI binding, an R2 binding does not force a remote session, so uploads work credential-free in the sandbox. Objects live under `.wrangler/state/v3/r2/<bucket_name>/` next to the D1 sqlite; the same `--persist-to .wrangler/state` rule from `cloudflare-workers-e2e-playwright` applies, otherwise `vite dev` and `wrangler dev --config dist/…` see two different buckets and uploads "disappear".
4. Types: `PHOTOS_BUCKET: R2Bucket` in `Bindings` (global type via `wrangler types`).

## Key scheme and the attachments row

```
photos/<spaceId>/<parentId>/<attachmentId>          full-size (≤ 1600 px JPEG)
photos/<spaceId>/<parentId>/<attachmentId>/w320     thumbnail (client variant or Images-binding cache)
```

- **No extension.** The content type is validated once at upload and stored in R2 `httpMetadata.contentType` *and* the D1 row; the serve route never guesses from the key
- The `spaceId` prefix means `list({ prefix: "photos/<spaceId>/" })` can audit or wipe one family's objects without touching another's
- D1 row (`attachments`): `id`, `record_id` (FK → the parent that carries `space_id`, `ON DELETE CASCADE`), `r2_key`, `thumb_key` (nullable), `content_type`, `size_bytes`, `width`, `height`, `original_filename`, `created_by`, `created_at`. Schema and routes in [references/worker-routes.md](references/worker-routes.md). For matatabetai: parent = `meals`, table = `meal_photos`

## Upload route — validate before `put`, `put` before INSERT

Order of checks (each one returns before the next runs):

1. Parent row resolved **through** `memberSpaceIds` (404 if it isn't in one of your spaces — existence-hiding, same rule as every other route)
2. `Content-Type` header starts with `multipart/form-data`, else 400 — `c.req.formData()` **throws** on anything else and you'd get an opaque 500
3. `const file = form.get("file")`; reject `null` and `string` (400). Don't write `file instanceof File` — the Worker tsconfig fails it with TS2358; excluding the other two members of `FormDataEntryValue` narrows to `File`
4. `file.size === 0` → 400; `file.size > MAX_IMAGE_BYTES` (10 MB) → 413 `attachment_too_large`
5. **Sniff the first 12 bytes** (`FF D8 FF` JPEG, `89 50 4E 47 0D 0A 1A 0A` PNG, `RIFF….WEBP`, `ftyp` + HEIF brand) and allow only `image/jpeg` / `image/png` / `image/webp` → 415 `attachment_type_not_allowed` otherwise. `file.type` is whatever the client said; store the **sniffed** type, not `file.type`
6. `PHOTOS_BUCKET.put(key, bytes, { httpMetadata: { contentType } })` — then the optional `thumb` field the same way
7. INSERT the row. If the INSERT throws, `delete` the object(s) you just put and rethrow — an object without a row is an orphan nobody can ever delete through the app
8. 201 with the row plus its serve URL

## Serve route — authorize before touching R2

```
sessionMiddleware → parent ∈ memberSpaceIds → attachment.record_id === parent.id → PHOTOS_BUCKET.get(key, { onlyIf: request.headers })
```

- The chain is N hops of "child row points at the row I already trusted"; only the first hop checks space membership. Every miss is **404**, never 403
- `onlyIf: c.req.raw.headers` lets R2 evaluate the browser's `If-None-Match` / `If-Modified-Since`; when the precondition fails R2 returns an `R2Object` **without** `body` → respond `304` with `ETag` + `Cache-Control`. (Documented R2 API; not yet exercised in the source projects — see UNVERIFIED)
- Headers: `Content-Type` from the DB row, `Content-Length: obj.size` (**not** the DB value — they drift after a re-upload or a cached transform), `ETag: obj.httpEtag`, `Cache-Control: private, max-age=3600`, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`
- `null` from `get` with a row present = DB/R2 inconsistency → 404 and `console.error` (it should never happen with the delete ordering below)
- Never `public` and never the Cache API: the edge cache is keyed by URL, not by cookie — one cached `public` response is every family's photo for an hour

## Delete — R2 first (best-effort), then D1

- Single attachment: `delete([r2Key, thumbKey])` → DB delete. If R2 throws, the row survives and the user retries; the reverse order turns a transient R2 failure into a permanent 404 row
- Parent delete: `SELECT r2_key, thumb_key WHERE record_id = ?` → one `delete(keys[])` call (array form, up to 1,000 keys — one call instead of N, which also matters under the Free plan's 50-subrequest cap) → delete the parent (rows cascade)
- Orphans are acceptable at family scale; an optional weekly sweep (`list({ prefix: "photos/" })` minus the rows, skipping objects uploaded in the last hour) is sketched in [references/e2e-and-ops.md](references/e2e-and-ops.md) — cron plumbing per `cloudflare-cron-to-discord`

## Client — downscale, strip EXIF, then FormData

- `<input type="file" accept="image/*">`. Adding `capture="environment"` forces the camera and **hides the gallery picker** on most mobile browsers — offer it as a second button, not the default
- `createImageBitmap(file, { imageOrientation: "from-image" })` → canvas with the longest side ≤ 1600 px → `canvas.toBlob("image/jpeg", 0.85)`; same bitmap again at 320 px for the thumb. A canvas re-encode carries **no EXIF**, so GPS (your home) and device info never reach the server; 3–8 MB phone photos become ~200–400 KB, which makes the 10 GB free tier good for tens of thousands of photos
- If decoding throws (Chrome/Firefox/Android cannot decode HEIC) the helper returns `null`; the UI tells the user to switch iPhone Camera → Formats → *Most Compatible* or share as JPEG. Safari *can* decode HEIC into the canvas, so on iOS the file still becomes a JPEG. The server rejects HEIC (415) precisely so that an Android family member never gets a broken `<img>` — nyalog instead accepted HEIC and downgraded it to a download link, which is the right call only for documents nobody needs to *see* inline
- `FormData` + **raw `fetch`** — never set `Content-Type` yourself (the boundary is generated by fetch) and don't route through a JSON `request()` wrapper that forces `application/json`
- Code in [references/client-resize-upload.md](references/client-resize-upload.md)

## Thumbnails — two client variants by default

| | Option 1 (default): client uploads `full` + `thumb` | Option 2: Images binding, cached back into R2 |
|---|---|---|
| Cost | zero transformations | 1 unique transformation **per image, once** (cached under `<key>/w320`), not per view |
| Local dev / e2e | identical to prod | `wrangler dev` runs a **low-fidelity offline** Images implementation (width / height / rotate / format only) — don't assert on thumbnail bytes locally; `--remote` needs credentials |
| Free plan | n/a | beyond 5,000 unique/month the binding returns error **9422** (no charge) — fall back to the full image |
| Extra wiring | one more form field | `"images": { "binding": "IMAGES" }`, max input 20 MB |

Both in [references/thumbnails-and-images-binding.md](references/thumbnails-and-images-binding.md). Option 2 is the right move only when you need variants the client didn't produce (a later redesign) — and never transform per request with client-chosen widths: every new `(image, options)` pair is a new unique transformation.

## e2e — one golden-path extension, not a new suite

Stay inside the "3 specs" philosophy of `cloudflare-workers-e2e-playwright`: extend the golden path with `setInputFiles` (a 74-byte PNG fixture, the client resize runs for real in headless Chromium) → POST 201 → `<img>` `naturalWidth > 0` → direct `GET` is `200` with `cache-control: private` → the *other* seeded user's session gets `404` → delete → `404`. Whether the R2 object is physically gone is checked via the local state directory, command in [references/e2e-and-ops.md](references/e2e-and-ops.md) (marked unverified). In the sandbox nothing changes: R2 is local, see `playwright-e2e-in-docker-sandbox`.

## Backup — decide and write it down

R2 has **no point-in-time recovery**; bucket locks only *prevent* deletion/overwrite for a retention period and would break the app's own delete feature if applied to the live bucket. Options (table with costs in [references/decision-matrix.md](references/decision-matrix.md)): accept the risk (the phones keep the originals — the app stores downscaled copies, so for a meal log this is the honest default), `rclone sync` to a second bucket from a GitHub Actions cron using an R2 **S3 API token** (a separate token type, created under R2 → Manage R2 API Tokens — not the Workers R2 Storage permission), or sync to another provider if the archive is irreplaceable. D1 backups stay with `cloudflare-d1-weekly-backup-via-pr`. Record the choice in an ADR; "we'll think about it later" is how family photos vanish.

## The pitfalls that eat hours

- **Trusting `file.type`** — it's client-controlled; a `.exe` renamed `.jpg` with `image/jpeg` passes an allowlist. Sniff the bytes, store the sniffed type
- **`Content-Length` from the DB row** — after a re-upload or a cached transform the object size differs and the browser truncates or hangs. Use `obj.size`
- **Token lacks `Workers R2 Storage: Edit`** — deploy/build fails with `code: 10000` on `/r2/buckets/<name>`; the dash-generated Workers Builds token includes it (2026-08-23), a hand-made or older build token may not
- **`Cache-Control: public` or `caches.default.put()` on an authenticated image** — cross-user leak at the edge. `private` only
- **"Just make the bucket public for now"** — there is no "for now" for a URL that was shared once
- **Images binding local-dev divergence** — low-fidelity offline in `wrangler dev`; quality/blur/format nuances only exist with `--remote` (credentials) or in prod
- **Free-plan 9422** — transforming per view with client-supplied widths burns unique transformations; fix the variant set and cache into R2
- **`.wrangler/state` mismatch** — `vite dev` and `wrangler dev --config dist/…/wrangler.json` resolve state differently; uploads vanish between them. `--persist-to .wrangler/state`, same as D1
- **Bytes through Workflows steps** — `step.do()` outputs must be JSON; pass the R2 key and re-`get` inside the step (`cloudflare-workflows-for-long-tasks`)
- **`c.req.formData()` on a non-multipart body** throws → 500 with no hint; guard the header first
- **Deleting the DB row before the object** — a transient R2 error then leaves an object with no row (un-deletable through the app) and a 404 that looks like data loss
- **`capture="environment"`** hides "choose from gallery" on phones
- **Japanese filenames in `Content-Disposition`** — plain `filename="…"` breaks; use `filename*=UTF-8''<percent-encoded>` or omit the filename for `inline`
- **Transparent PNG → JPEG** loses alpha (black background). Meal photos are camera JPEGs, so JPEG output is fine; keep PNG for screenshots if that matters

## Unverified claims — confirm while implementing, then write back

Write-back rule: when a bullet is confirmed or corrected, edit this section *and* the reference that carries the code, add "(verified YYYY-MM-DD in <project>)", bump `metadata.version`, and ship it as `feat(r2-image-upload): … を還元`.

- UNVERIFIED: magic-bytes sniffing is standard practice but **not battle-tested in the source projects** (nyalog checks only `file.type`). Confirm the JPEG/PNG/WebP/HEIF signatures against real phone uploads (including a WebP from Android Chrome) and that a renamed non-image is rejected with 415
- UNVERIFIED: `get(key, { onlyIf: request.headers })` returning a body-less `R2Object` on `If-None-Match` match, and the resulting 304 path, have not been exercised in nyalog/routine-tasks. Check with `curl -H 'If-None-Match: <etag>'` against local dev and prod
- UNVERIFIED: iOS Safari transcodes HEIC → JPEG when the picker is opened with `accept="image/*"` (and may send the original HEIC when `accept` lists `image/heic`). Test on a current iPhone with Camera → Formats → *High Efficiency*; record the iOS version
- UNVERIFIED: `createImageBitmap(file, { imageOrientation: "from-image" })` orientation handling on current Safari and Firefox; test with a portrait photo from each family phone and note which browsers needed the `<img>`-decode fallback
- UNVERIFIED: the Images binding's accepted input formats — whether HEIC input is supported (docs list max 20 MB input but no HEIC statement). Don't plan server-side HEIC transcoding until confirmed
- UNVERIFIED: exact local inspection command and layout — `wrangler r2 object get <bucket>/<key> --local --persist-to .wrangler/state` and blobs under `.wrangler/state/v3/r2/<bucket_name>/`. Confirm the path and the exit code for a missing key (needed by the e2e "object really gone" assertion)
- UNVERIFIED: whether R2 binding calls count toward the Workers Free 50-subrequest cap. If they do, the per-key `delete` loop is a real bug on large parent deletes; the array form sidesteps it either way
- UNVERIFIED: `delete(keys: string[])` accepting up to 1,000 keys in the current runtime — confirm the signature in the `wrangler types` output
- UNVERIFIED: "R2 has no object versioning" is inferred from the absence of any versioning/PITR mention on the bucket-locks page (2026-08-22). Re-check https://developers.cloudflare.com/r2/ before the backup ADR
- UNVERIFIED: the `rclone` + R2 S3 token backup sketch has never run in these projects; the env-var config form (`RCLONE_CONFIG_R2_*`) and the `Cloudflare` provider name need one successful dry run
- UNVERIFIED: an actual R2 deploy through Workers Builds — the generated build token lists `Workers R2 Storage (edit)` (docs and dashboard notice, 2026-08-23) but no R2-bound Worker has been deployed through it yet; the permission requirement itself is verified only for the GH Actions token in `cloudflare-api-token-permissions`
- UNVERIFIED: `canvas.toBlob("image/jpeg")` inside the sandbox-baked headless Chromium (no GPU) — expected to work; the first e2e run settles it

## Scope boundary — what this skill does NOT cover

- Sessions, passkeys, the session cookie — `cloudflare-workers-passkey-auth`
- `memberSpaceIds`, `spaces` / `space_members`, the 404 existence-hiding rule and invites — `cloudflare-workers-space-membership-invite` (this skill only *consumes* `c.get("memberSpaceIds")`)
- Token permission matrix and the in-place token edit — `cloudflare-api-token-permissions`; the Workers Builds custom token flow — `cloudflare-workers-builds-keyless-deploy`
- Playwright wiring, the CSP/HMR trap, `--persist-to` — `cloudflare-workers-e2e-playwright`; running it in the sandbox — `playwright-e2e-in-docker-sandbox`
- Post-upload processing longer than 30 s (Vision LLM on the photo) — `cloudflare-workflows-for-long-tasks` (pass the key, not the bytes)
- D1 backups — `cloudflare-d1-weekly-backup-via-pr`; cron plumbing for the orphan sweep — `cloudflare-cron-to-discord`
- Presigned S3 uploads, multipart uploads, video, public buckets, custom domains on R2 — out of scope by decision

## References

- [decision-matrix.md](references/decision-matrix.md) — full option matrix, the 2026-08-22 verified pricing table with sources, migration triggers, backup decision table
- [worker-routes.md](references/worker-routes.md) — Drizzle schema, `wrangler.jsonc`, `Bindings`, magic-bytes helper, upload / serve / delete / parent-delete templates
- [client-resize-upload.md](references/client-resize-upload.md) — `prepareImage()` (decode → downscale → JPEG, EXIF gone), HEIC handling, `FormData` upload, React usage
- [thumbnails-and-images-binding.md](references/thumbnails-and-images-binding.md) — client-variant thumbnails vs Images binding cached into R2, config, counting rules, local-dev caveat
- [e2e-and-ops.md](references/e2e-and-ops.md) — Playwright spec with the PNG fixture, local R2 inspection, orphan sweep, backup workflow sketch, runbook
