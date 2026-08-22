# Worker side: schema, binding, validation, upload / serve / delete

Copy-ready for Hono + Drizzle (`drizzle-orm/d1`) on the `cloudflare-workers-deploy-skeleton` layout. Names use a generic parent called `records`; for matatabetai read `records` → `meals`, `attachments` → `meal_photos`, `/api/records/:recordId/attachments` → `/api/meals/:mealId/photos`. Assumes `sessionMiddleware` (from `cloudflare-workers-passkey-auth`) already set `c.var.userId` and `c.var.memberSpaceIds` (from `cloudflare-workers-space-membership-invite`).

## 1. `wrangler.jsonc`

```jsonc
{
  // ...assets, d1_databases, vars...
  "r2_buckets": [
    {
      "binding": "PHOTOS_BUCKET",
      "bucket_name": "<app>-photos"   // create first: pnpm exec wrangler r2 bucket create <app>-photos
    }
  ]
  // Optional, only for thumbnails-and-images-binding.md option 2:
  // "images": { "binding": "IMAGES" }
}
```

If you keep a credential-free `wrangler.local.jsonc` for dev/e2e (nyalog pattern — it exists to drop the AI binding), copy the `r2_buckets` block there verbatim. R2 is simulated locally; the AI binding is the one that forces a remote session.

## 2. `worker/types.ts`

```ts
import type { SpaceId, UserId } from "./domain/ids";

// R2Bucket / D1Database / Fetcher / ImagesBinding are globals from `wrangler types`
// (or @cloudflare/workers-types). No import.
export type Bindings = {
  DB: D1Database;
  ASSETS: Fetcher;
  PHOTOS_BUCKET: R2Bucket;
  // IMAGES?: ImagesBinding;   // option 2 only
  SESSION_SECRET: string;
  ORIGIN: string;
};

type Variables = {
  userId: UserId;
  memberSpaceIds: SpaceId[];
};

export type Env = { Bindings: Bindings; Variables: Variables };
```

## 3. Schema (`worker/db/schema.ts`, excerpt)

```ts
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { spaces, users } from "./auth-schema"; // users / spaces / space_members live with the auth + space skills

// The parent row. It is the ONLY row in this chain that carries space_id.
export const records = sqliteTable(
  "records",
  {
    id: text("id").primaryKey(),
    spaceId: text("space_id")
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    // ...domain columns (for meals: name, eaten_at, note, ...)
    createdBy: text("created_by").references(() => users.id),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({ spaceIdIdx: index("records_space_id_idx").on(t.spaceId) }),
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(), // UUID; also the last key segment
    recordId: text("record_id")
      .notNull()
      .references(() => records.id, { onDelete: "cascade" }),
    r2Key: text("r2_key").notNull(),          // photos/<spaceId>/<recordId>/<id>
    thumbKey: text("thumb_key"),              // photos/<spaceId>/<recordId>/<id>/w320, null if none
    contentType: text("content_type").notNull(), // the SNIFFED type, never file.type verbatim
    sizeBytes: integer("size_bytes").notNull(),
    width: integer("width"),
    height: integer("height"),
    originalFilename: text("original_filename"),
    createdBy: text("created_by").references(() => users.id),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({ recordIdIdx: index("attachments_record_id_idx").on(t.recordId) }),
);
```

`ON DELETE CASCADE` from `records` is what lets the parent delete rely on "rows cascade, objects are deleted explicitly first". Read `cloudflare-d1-drizzle-migration` before any later table-rebuild migration on `records` — D1 ignores `PRAGMA foreign_keys=OFF`, and a rebuild of the parent cascade-deletes every attachment row (the objects would then be orphans).

## 4. Magic-bytes helper (`worker/lib/image-sniff.ts`)

```ts
export const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"] as const);
export type AllowedImageType = "image/jpeg" | "image/png" | "image/webp";
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // policy; the platform cap is 100 MB on Free/Pro

// ISO BMFF brands that identify HEIF containers (iPhone HEIC photos, HEIF sequences).
const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);

function ascii(bytes: Uint8Array, from: number, to: number): string {
  return String.fromCharCode(...bytes.subarray(from, to));
}

/**
 * Identify the container from the first 12 bytes. `file.type` is whatever the client claimed;
 * this is what the bytes actually are. Returns "image/heic" so the caller can give a specific
 * error, and null for everything else (PDF, EXE, HTML, ...).
 */
export function sniffImageType(head: Uint8Array): AllowedImageType | "image/heic" | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (
    head.length >= 8 &&
    head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
    head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a
  ) return "image/png";
  if (head.length >= 12 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 12) === "WEBP") return "image/webp";
  if (head.length >= 12 && ascii(head, 4, 8) === "ftyp" && HEIF_BRANDS.has(ascii(head, 8, 12))) return "image/heic";
  return null;
}
```

UNVERIFIED in the source projects (nyalog validates `file.type` only): confirm with real uploads from each family phone — a JPEG from iOS, a WebP from Android Chrome's share sheet, a renamed `.txt` → must be 415.

## 5. Routes (`worker/routes/attachments.ts`)

```ts
import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, inArray } from "drizzle-orm";
import { attachments, records } from "../db/schema";
import { RecordId } from "../domain/ids";
import type { SpaceId } from "../domain/ids";
import { ALLOWED_IMAGE_TYPES, MAX_IMAGE_BYTES, sniffImageType } from "../lib/image-sniff";
import type { Env } from "../types";

type Db = ReturnType<typeof drizzle>;
const notFound = { error: { type: "not_found" } } as const;

// First hop of the chain: the parent must be in one of the caller's spaces. Anything else is 404
// (existence-hiding — a 403 would confirm the id exists).
async function resolveRecord(db: Db, rawId: string, memberSpaceIds: SpaceId[]) {
  const parsed = RecordId.safeParse(rawId);
  if (!parsed.success || memberSpaceIds.length === 0) return null; // inArray([]) must never be built
  const rows = await db
    .select({ id: records.id, spaceId: records.spaceId })
    .from(records)
    .where(and(eq(records.id, parsed.data), inArray(records.spaceId, memberSpaceIds)));
  return rows[0] ?? null;
}

function isMultipart(c: { req: { header: (n: string) => string | undefined } }): boolean {
  return (c.req.header("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");
}

// Validate one multipart part: present, a File, non-empty, under the cap, and a real JPEG/PNG/WebP.
async function readImagePart(form: FormData, field: string, required: boolean) {
  const part = form.get(field);
  // FormDataEntryValue = string | File | null. `part instanceof File` fails the worker tsconfig
  // (TS2358), so narrow by excluding the other two members instead.
  if (part === null || typeof part === "string") {
    return required
      ? { ok: false as const, status: 400 as const, error: { type: "validation_error", message: `field '${field}' must be a file` } }
      : { ok: true as const, image: null };
  }
  if (part.size === 0) {
    return { ok: false as const, status: 400 as const, error: { type: "validation_error", message: `field '${field}' is empty` } };
  }
  if (part.size > MAX_IMAGE_BYTES) {
    return { ok: false as const, status: 413 as const, error: { type: "attachment_too_large", sizeBytes: part.size, maxBytes: MAX_IMAGE_BYTES } };
  }
  const bytes = new Uint8Array(await part.arrayBuffer());
  const sniffed = sniffImageType(bytes.subarray(0, 12));
  if (sniffed === null || !ALLOWED_IMAGE_TYPES.has(sniffed as never)) {
    // HEIC gets its own message so the UI can say "switch the iPhone camera to Most Compatible".
    return { ok: false as const, status: 415 as const, error: { type: "attachment_type_not_allowed", contentType: sniffed ?? (part.type || "unknown") } };
  }
  return { ok: true as const, image: { bytes, contentType: sniffed as "image/jpeg" | "image/png" | "image/webp", name: part.name || null } };
}

export const attachmentRoutes = new Hono<Env>()
  // POST /api/records/:recordId/attachments   multipart: file (required), thumb (optional), width, height
  .post("/", async (c) => {
    const db = drizzle(c.env.DB);
    const record = await resolveRecord(db, c.req.param("recordId") ?? "", c.get("memberSpaceIds"));
    if (!record) return c.json(notFound, 404);
    if (!isMultipart(c)) {
      // c.req.formData() THROWS on a non-multipart body → an opaque 500 without this guard
      return c.json({ error: { type: "validation_error", message: "expected multipart/form-data" } }, 400);
    }
    const form = await c.req.formData();

    const full = await readImagePart(form, "file", true);
    if (!full.ok) return c.json({ error: full.error }, full.status);
    const thumb = await readImagePart(form, "thumb", false);
    if (!thumb.ok) return c.json({ error: thumb.error }, thumb.status);
    const width = Number(form.get("width")) || null;
    const height = Number(form.get("height")) || null;

    const id = crypto.randomUUID();
    const key = `photos/${record.spaceId}/${record.id}/${id}`;
    const thumbKey = thumb.image ? `${key}/w320` : null;

    // put BEFORE insert: a row pointing at a missing object is a permanent 404; an object without
    // a row is an orphan we can still compensate for right here.
    await c.env.PHOTOS_BUCKET.put(key, full.image!.bytes, {
      httpMetadata: { contentType: full.image!.contentType },
    });
    if (thumb.image && thumbKey) {
      await c.env.PHOTOS_BUCKET.put(thumbKey, thumb.image.bytes, {
        httpMetadata: { contentType: thumb.image.contentType },
      });
    }

    const now = new Date().toISOString();
    try {
      await db.insert(attachments).values({
        id,
        recordId: record.id,
        r2Key: key,
        thumbKey,
        contentType: full.image!.contentType,
        sizeBytes: full.image!.bytes.byteLength,
        width,
        height,
        originalFilename: full.image!.name,
        createdBy: c.get("userId"),
        createdAt: now,
      });
    } catch (e) {
      // Compensate so the failed upload leaves nothing behind in R2.
      await c.env.PHOTOS_BUCKET.delete(thumbKey ? [key, thumbKey] : key);
      throw e;
    }

    return c.json(
      {
        id,
        recordId: record.id,
        contentType: full.image!.contentType,
        sizeBytes: full.image!.bytes.byteLength,
        width,
        height,
        hasThumb: thumbKey !== null,
        createdAt: now,
        url: `/api/records/${record.id}/attachments/${id}`,
      },
      201,
    );
  })

  // GET /api/records/:recordId/attachments/:attachmentId[?variant=thumb]
  .get("/:attachmentId", async (c) => {
    const db = drizzle(c.env.DB);
    const record = await resolveRecord(db, c.req.param("recordId") ?? "", c.get("memberSpaceIds"));
    if (!record) return c.json(notFound, 404);

    // Second hop: the attachment must point at the parent we just trusted.
    const rows = await db
      .select()
      .from(attachments)
      .where(and(eq(attachments.id, c.req.param("attachmentId")), eq(attachments.recordId, record.id)));
    const row = rows[0];
    if (!row) return c.json(notFound, 404);

    const key = c.req.query("variant") === "thumb" && row.thumbKey ? row.thumbKey : row.r2Key;

    // Only now touch R2. onlyIf lets R2 evaluate If-None-Match / If-Modified-Since itself.
    const obj = await c.env.PHOTOS_BUCKET.get(key, { onlyIf: c.req.raw.headers });
    if (obj === null) {
      // Row without object = inconsistency (should be impossible with the delete ordering). 404, but log it.
      console.error("attachment row without R2 object", { key });
      return c.json(notFound, 404);
    }

    const headers = new Headers({
      "Cache-Control": "private, max-age=3600", // NEVER public, NEVER the Cache API — keyed by URL, not cookie
      ETag: obj.httpEtag,
      "X-Content-Type-Options": "nosniff",
    });
    if (!("body" in obj)) {
      // Precondition failed → R2Object without body. (UNVERIFIED in these projects; documented API.)
      return new Response(null, { status: 304, headers });
    }
    headers.set("Content-Type", row.contentType); // validated at upload; don't trust the key or the client
    headers.set("Content-Length", String(obj.size)); // obj.size, not the DB value — they drift
    headers.set("Content-Disposition", "inline"); // no filename: Japanese names need RFC 5987 filename*= encoding
    return new Response(obj.body, { status: 200, headers });
  })

  // DELETE /api/records/:recordId/attachments/:attachmentId
  .delete("/:attachmentId", async (c) => {
    const db = drizzle(c.env.DB);
    const record = await resolveRecord(db, c.req.param("recordId") ?? "", c.get("memberSpaceIds"));
    if (!record) return c.json(notFound, 404);
    const rows = await db
      .select({ id: attachments.id, r2Key: attachments.r2Key, thumbKey: attachments.thumbKey })
      .from(attachments)
      .where(and(eq(attachments.id, c.req.param("attachmentId")), eq(attachments.recordId, record.id)));
    const row = rows[0];
    if (!row) return c.json(notFound, 404);

    // R2 first. If this throws, the row survives and the user retries; deleting the row first would
    // turn a transient R2 failure into an un-deletable orphan object.
    await c.env.PHOTOS_BUCKET.delete(row.thumbKey ? [row.r2Key, row.thumbKey] : row.r2Key);
    await db.delete(attachments).where(eq(attachments.id, row.id));
    return c.json({});
  });
```

Mount under the session-protected API exactly like nyalog does:

```ts
// worker/index.ts
protectedApi.use("/*", sessionMiddleware());
protectedApi.route("/records/:recordId/attachments", attachmentRoutes);
```

### Parent delete — collect keys, one `delete(keys[])`, then cascade

```ts
// inside DELETE /api/records/:recordId, after resolveRecord
const atts = await db
  .select({ r2Key: attachments.r2Key, thumbKey: attachments.thumbKey })
  .from(attachments)
  .where(eq(attachments.recordId, record.id));
const keys = atts.flatMap((a) => (a.thumbKey ? [a.r2Key, a.thumbKey] : [a.r2Key]));
if (keys.length > 0) {
  // Array form: one call for up to 1,000 keys (UNVERIFIED: confirm the signature in `wrangler types`).
  // A per-key loop is N subrequests — and Workers Free allows 50 per invocation
  // (UNVERIFIED whether R2 binding calls count toward that cap; the array form avoids the question).
  await c.env.PHOTOS_BUCKET.delete(keys);
}
await db.delete(records).where(eq(records.id, record.id)); // attachment rows cascade
```

### Notes on the R2 API used here

- `put(key, ArrayBuffer | ArrayBufferView | Blob | string | ReadableStream, { httpMetadata, customMetadata })` — a stream needs a known length; the multipart `File` is already in memory, so `arrayBuffer()` is the simple path (the 10 MB cap keeps it well under the 128 MB Worker memory limit)
- `get(key, { onlyIf: Headers | R2Conditional, range? })` → `R2ObjectBody` (has `body`) | `R2Object` (precondition failed, no `body`) | `null` (missing)
- `R2Object`: `key`, `size`, `etag`, `httpEtag` (quoted — what the `ETag` header wants), `uploaded: Date`, `httpMetadata`, `customMetadata`, `writeHttpMetadata(headers)`
- `delete(key | key[])`; `list({ prefix, cursor, limit ≤ 1000, include? })` → `{ objects, truncated, cursor }`
- `head(key)` → `R2Object | null` when you need size/etag without the body
