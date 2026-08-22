# Thumbnails: client variants (default) vs the Images binding cached into R2

## Option 1 — the client uploads `full` + `thumb` (default)

Already wired in [worker-routes.md](worker-routes.md) (`thumb` form field → `<key>/w320`) and [client-resize-upload.md](client-resize-upload.md) (`prepareImage` returns both). Properties:

- Zero transformation quota, zero extra bindings, nothing that behaves differently in local dev
- The thumbnail is exactly what the browser that took the photo rendered — no format surprises
- Cost: one more Class A op per upload and ~20 KB of storage; irrelevant against the free tier
- Limitation: the variant set is fixed at upload time. A later redesign that wants 640 px cards has to either re-upload or fall back to the full image (CSS downscales it — at 1600 px that's acceptable on mobile)

Serve with `?variant=thumb`; the route falls back to the full object when `thumb_key` is null, so older rows never 404.

## Option 2 — Images binding, transform once, cache the result in R2

Use this only for variants the client didn't produce. The rule that keeps it free: **transform each image at most once per variant and store the output back in R2** under `<key>/w<width>`. Per-view transforms with client-chosen widths create a new unique `(image, options)` pair each time and burn through the 5,000/month quota.

### Config

```jsonc
// wrangler.jsonc
"images": { "binding": "IMAGES" }
```

```ts
// worker/types.ts
IMAGES: ImagesBinding; // global type from `wrangler types`
```

The binding needs no account-level product purchase; on the Free plan it simply stops with error `9422` after 5,000 unique transformations in a month (verified 2026-08-22, https://developers.cloudflare.com/images/pricing/). Max input is 20 MB (https://developers.cloudflare.com/images/transform-images/bindings/).

### Lazy variant with write-back

```ts
// GET /:attachmentId?variant=w640  — a variant the client never uploaded
const width = 640; // fixed allowlist of widths; never take the number from the query string verbatim
const variantKey = `${row.r2Key}/w${width}`;

let obj = await c.env.PHOTOS_BUCKET.get(variantKey, { onlyIf: c.req.raw.headers });
if (obj === null) {
  const src = await c.env.PHOTOS_BUCKET.get(row.r2Key);
  if (src === null) return c.json(notFound, 404);

  let bytes: ArrayBuffer;
  let contentType: string;
  try {
    const out = await c.env.IMAGES.input(src.body).transform({ width }).output({ format: "image/jpeg", quality: 80 });
    bytes = await out.response().arrayBuffer(); // R2 put needs a known length; don't pipe the stream
    contentType = out.contentType();
  } catch (e) {
    // Free-plan quota exhausted (9422) or an unsupported input: serve the full image instead of failing.
    console.error("images transform failed, serving original", { key: row.r2Key, e });
    obj = await c.env.PHOTOS_BUCKET.get(row.r2Key, { onlyIf: c.req.raw.headers });
    if (obj === null) return c.json(notFound, 404);
    return respondWithObject(obj, row.contentType); // same header logic as the main serve route
  }

  await c.env.PHOTOS_BUCKET.put(variantKey, bytes, { httpMetadata: { contentType } });
  obj = await c.env.PHOTOS_BUCKET.get(variantKey);
  if (obj === null) return c.json(notFound, 404);
}
return respondWithObject(obj, "image/jpeg");
```

Two writers racing to create the same variant both succeed (`put` is idempotent on the same key); the second transform is a wasted unique transformation, not a bug. If that matters, use `put(variantKey, bytes, { onlyIf: { etagDoesNotMatch: "*" } })` — UNVERIFIED that the wildcard form is accepted; plain overwrite is fine at family scale.

### What the binding can and cannot do

- `transform({ width, height, fit, rotate, blur, sharpen, ... })` chained, then `output({ format, quality })`; `env.IMAGES.info(stream)` returns `{ format, fileSize, width, height }` if you need dimensions server-side
- **Local dev**: `wrangler dev` / the Vite plugin run a low-fidelity **offline** implementation that supports only `width`, `height`, `rotate`, `format`. Quality, blur, sharpen, fit modes and format nuances only behave like production under `wrangler dev --remote` (needs credentials — not available in the `claude-code-docker-sandbox` flow) or in production. Consequence for e2e: assert that the variant route returns 200 with an image content type, never assert on bytes or dimensions
- HEIC **input** support is UNVERIFIED (the docs page lists the 20 MB limit but no HEIC statement). Do not design server-side HEIC → JPEG transcoding on this binding until a production test proves it; the client-side policy in [client-resize-upload.md](client-resize-upload.md) doesn't depend on it
- The `/cdn-cgi/image/<options>/<url>` URL form is a different mechanism that needs a *public* origin and is therefore unusable for a private bucket — don't conflate the two

### Delete and cleanup with variants

Variants live under the attachment's key as a prefix (`<key>/w320`, `<key>/w640`), so the delete route and the orphan sweep can use `list({ prefix: row.r2Key + "/" })` to find every variant without the DB knowing about each one. Keep the full object at exactly `<key>` (no trailing segment) so the prefix never matches itself ambiguously.
