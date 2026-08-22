# Decision matrix: where do private user photos live on Cloudflare?

Numbers below were read from the linked developers.cloudflare.com pages on **2026-08-22**. Re-verify before quoting them in a new ADR — pricing pages change, and this is exactly how nyalog's ADR-006 ended up stating a "25 GB / 5K writes" R2 free tier that never existed.

## Verified pricing and limits (2026-08-22)

| Item | Value | Source |
|---|---|---|
| R2 free tier (Standard storage only) | **10 GB-month** storage, **1,000,000 Class A** ops/month, **10,000,000 Class B** ops/month, **egress free** | https://developers.cloudflare.com/r2/pricing/ |
| R2 Class A (mutating) | `PutObject`, `ListObjects`, `CopyObject`, multipart create/upload-part | same |
| R2 Class B (read) | `GetObject`, `HeadObject`, `HeadBucket` | same |
| R2 deletes | `DeleteObject` / `DeleteBucket` / `AbortMultipartUpload` are **free** | same |
| Images transformations, Free plan | **5,000 unique transformations/month** free; beyond that new transformations return **error `9422`**, nothing is charged | https://developers.cloudflare.com/images/pricing/ |
| Images transformations, Paid | first 5,000 included, then **$0.50 per 1,000** unique transformations/month | same |
| Images stored/delivered (the "Images" product, not R2) | **$5 per 100,000 stored/month**, **$1 per 100,000 delivered/month** | same |
| Which counter a binding transform hits | a transform through the **Images binding** counts as "Images Transformed" (the transformation quota), not "Images Delivered" | same |
| Images binding | `"images": { "binding": "IMAGES" }`; `env.IMAGES.input(stream).transform(...).output(...)`; **max 20 MB input**; `wrangler dev` = low-fidelity offline implementation (width / height / rotate / format only), `wrangler dev --remote` = the real one | https://developers.cloudflare.com/images/transform-images/bindings/ |
| Local simulation of bindings | default is local simulation for every binding except AI; Images local simulation "limited to a subset of features" | https://developers.cloudflare.com/workers/development-testing/ |
| Workers request body | **100 MB** Free and Pro, 200 MB Business, 500 MB Enterprise (by default) | https://developers.cloudflare.com/workers/platform/limits/ |
| Workers subrequests | **50** per invocation on Free; 10,000 (configurable) on Paid | same |
| Workers bundle | 3 MB gzipped Free, 10 MB Paid | same |
| R2 bucket locks | prevent deletion/overwriting of objects for a period or indefinitely; a **preventative** control — no restore, no versioning, no PITR mentioned on the page | https://developers.cloudflare.com/r2/buckets/bucket-locks/ |

What the free tier means for a family meal log: a downscaled 1600 px JPEG is ~300 KB, so 10 GB ≈ 33,000 photos; one photo upload is 2 Class A ops (full + thumb) and a month of family browsing is a few thousand Class B ops. You will not leave the free tier by storing photos — only by serving them publicly at scale, which this design forbids anyway.

## The options

| Option | How reads are authorized | Monthly cost at family scale | Why it was / wasn't chosen |
|---|---|---|---|
| **A. Private R2 bucket + Worker proxy** (chosen) | The Worker runs `sessionMiddleware` → space membership → parent → attachment, then `BUCKET.get` | $0 (free tier) | One authz model for JSON and pixels; `<img src="/api/…">` sends the cookie automatically; R2 ops are three methods (`put` / `get` / `delete`); fully simulated in local dev |
| B. Public bucket (`r2.dev` subdomain or custom domain) | None — the URL is the credential | $0 | A shared URL can never be revoked; "obscure" UUID keys are not access control. Rejected for anything a family would call private |
| C. Cloudflare Images (stored images product) | Signed URLs (`/cdn-cgi/imagedelivery/…` with a token) or the binding | $5 per 100k stored + $1 per 100k delivered — **billed monthly regardless of volume tier** | Variants and format negotiation for free, but a fixed fee for ~100 photos/month; re-evaluate only at the migration triggers below |
| D. `/cdn-cgi/image/<options>/<source-url>` URL transformations | None — the source must be a **public** origin on your zone | 5,000 unique/month free | Structurally incompatible with a private bucket; the Worker can't put a cookie on an image-resizing origin fetch |
| E. Images **binding** inside the Worker | Same as A (it's bytes in the Worker) | 5,000 unique/month free; Free plan errors (`9422`) instead of billing | Viable as an *add-on* to A for variants the client didn't produce; cache results into R2 so each image is transformed once. Not needed when the client uploads full + thumb |
| F. Presigned S3 URLs (browser ↔ R2 direct) | Per-URL expiry; needs an **R2 API token** (S3 credentials, a different token type from `Workers R2 Storage: Edit`) | $0 | Saves Worker CPU/egress that is already free at this scale; adds a second credential, CORS on the bucket, and a client that must handle the upload/confirm dance. Nothing to gain for 4 users |

## Migration triggers (re-evaluate A when two or more hold)

- Accounts outside the family join and uploads exceed ~1,000 photos/month
- The UI needs several responsive variants per photo and the client-side two-variant upload becomes a maintenance burden
- You need every format a phone can produce (HEIC, AVIF) displayed transparently on every device → server-side transcoding → Images
- R2 usage is consistently above the 10 GB free tier *and* the downscale factor can't go further
- You need a CDN-cached public gallery (a share-with-grandparents link) — that's a different product decision (signed, expiring share links served by the Worker, or Images signed URLs)

## Backup / DR decision table

R2 offers no point-in-time recovery. Bucket locks prevent deletion for a retention period but (a) are not a restore mechanism and (b) would make the app's own "delete photo" fail if applied to the live bucket. Pick one row, write it into an ADR:

| Option | Protects against | Cost / complexity | When it's the right answer |
|---|---|---|---|
| **Accept the risk** (the phones' camera rolls keep the originals; the app stores downscaled copies) | nothing on the Cloudflare side | 0 | A meal log where the app is a *view* of photos that also live elsewhere — the honest default for matatabetai |
| `rclone sync` live bucket → a second R2 bucket, weekly GitHub Actions cron, R2 S3 API token (two new repo secrets) | app bugs, accidental deletes, a wiped bucket | one workflow + `Account → R2 → Manage R2 API Tokens` (object read on the source, write on the target); same account so **not** account loss | Photos that exist nowhere else |
| `rclone sync` to another provider (B2 / S3 / Drive) | Cloudflare account loss | R2 egress is free; the other side charges for storage | Irreplaceable archives |
| Bucket lock on the **backup** bucket only | deletion of the backup itself | a retention rule | Pairs with either sync option |
| App-level export (zip of a space's photos + JSON) served by the Worker | gives the family a way out | a route that streams `list({ prefix })` objects | When "I want my data" matters more than disaster recovery |

D1 rows (the metadata) are covered by `cloudflare-d1-weekly-backup-via-pr`; note that restoring D1 without the objects yields rows that 404 at serve time, and restoring objects without rows yields orphans — restore both from the same point in time or accept the mismatch consciously.

## What nyalog actually chose (for calibration)

- A, with a 10 MB cap, allowlist `image/jpeg` / `image/png` / `image/webp` / `image/heic` / `image/heif` / `application/pdf` (medical documents — HEIC and PDF fell to download links in the UI)
- Key `medical/<spaceId>/<catId>/<recordId>/<attachmentId>`, no extension, content type in R2 metadata + D1
- Serve headers `Content-Type` / `Content-Length` / `Cache-Control: private, max-age=3600`; no conditional GET yet
- Delete: R2 first (best-effort), then D1; orphans on cat delete accepted
- Backup: none for R2 (D1 weekly export only) — an unrecorded "accept the risk"
- Vision LLM analysis of uploaded scans runs in a Workflow that receives the **key**, never the bytes (`cloudflare-workflows-for-long-tasks`)
