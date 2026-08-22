# Client side: decode → downscale → JPEG (EXIF gone) → FormData

Why do this in the browser rather than in the Worker: the Worker has no image decoder unless you pay for the Images binding's quota, the phone has a GPU-backed decoder for free, and a 3–8 MB camera JPEG becomes ~200–400 KB *before* it crosses the network. The canvas re-encode is also the only reliable way to guarantee that EXIF — including the GPS coordinates of your kitchen — never reaches the server.

## `src/lib/image-prep.ts`

```ts
export type PreparedImage = { blob: Blob; width: number; height: number };
export type PreparedSet = { full: PreparedImage; thumb: PreparedImage };

const FULL_MAX_PX = 1600;  // plenty for a phone screen and a 2x desktop card
const THUMB_MAX_PX = 320;  // list / grid tiles
const JPEG_QUALITY = 0.85;

function fit(w: number, h: number, max: number): [number, number] {
  const scale = Math.min(1, max / Math.max(w, h)); // never upscale
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))];
}

async function encode(bitmap: ImageBitmap, maxPx: number): Promise<PreparedImage> {
  const [w, h] = fit(bitmap.width, bitmap.height, maxPx);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d context unavailable");
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
  if (!blob) throw new Error("canvas.toBlob returned null");
  return { blob, width: w, height: h }; // a canvas re-encode carries no EXIF / GPS / device info
}

/**
 * Returns null when the browser cannot decode the file (HEIC on Chrome/Firefox/Android, corrupt
 * data). The caller decides what to tell the user; nothing is uploaded in that case.
 */
export async function prepareImage(file: File): Promise<PreparedSet | null> {
  let bitmap: ImageBitmap;
  try {
    // "from-image" applies the EXIF orientation tag, so portrait phone photos are not sideways.
    // UNVERIFIED on current Safari / Firefox — see SKILL.md; fallback below if a browser ignores it.
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return null;
  }
  try {
    const full = await encode(bitmap, FULL_MAX_PX);
    const thumb = await encode(bitmap, THUMB_MAX_PX);
    return { full, thumb };
  } finally {
    bitmap.close();
  }
}
```

### Orientation fallback (only if a target browser ships photos sideways)

```ts
// Decode through an <img> instead; browsers apply EXIF orientation to <img> by default
// (CSS image-orientation: from-image). Whether drawImage() then honours it is browser-specific —
// test with a real portrait photo from each family phone before relying on either path.
async function decodeViaImg(file: File): Promise<ImageBitmap> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return await createImageBitmap(img);
  } finally {
    URL.revokeObjectURL(url);
  }
}
```

### Format notes

- Output is always JPEG. A transparent PNG becomes JPEG on a black background — meal photos are camera JPEGs, so this is fine; if screenshots with transparency matter, branch on `file.type === "image/png"` and call `toBlob(resolve, "image/png")` (bigger files) or `"image/webp"` (check Safari support for WebP *encoding* in your target versions)
- HEIC: Safari can decode HEIC into a canvas, so on an iPhone the photo still leaves the device as a JPEG. Chrome/Firefox/Android cannot → `prepareImage` returns `null` → show: "この写真は HEIC 形式です。iPhone の 設定 → カメラ → フォーマット → 互換性優先 にするか、JPEG で共有してください". The server rejects HEIC with 415 as a backstop, so nothing inconsistent can be stored. UNVERIFIED: iOS Safari is widely reported to transcode HEIC → JPEG in the file picker when `accept="image/*"` (and to send the original when `accept` names `image/heic`) — confirm on a current iPhone with Camera → Formats → *High Efficiency*, and record the iOS version in this file
- Very large sources (48 MP) decode fine via `createImageBitmap`; if memory becomes an issue on old phones, pass `resizeWidth` / `resizeHeight` / `resizeQuality: "high"` to `createImageBitmap` so the decoder downsamples before the canvas step

## Upload (`src/api.ts`)

```ts
import type { PreparedSet } from "./lib/image-prep";

export type AttachmentSummary = {
  id: string;
  recordId: string;
  contentType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  hasThumb: boolean;
  createdAt: string;
  url: string;
};

export async function uploadAttachment(
  recordId: string,
  prepared: PreparedSet,
  originalName: string,
): Promise<AttachmentSummary> {
  const fd = new FormData();
  const base = originalName.replace(/\.[^.]+$/, "") || "photo";
  fd.append("file", prepared.full.blob, `${base}.jpg`);
  fd.append("thumb", prepared.thumb.blob, `${base}-w320.jpg`);
  fd.append("width", String(prepared.full.width));
  fd.append("height", String(prepared.full.height));

  // Raw fetch on purpose: fetch sets `multipart/form-data; boundary=...` itself. Do NOT set
  // Content-Type manually and do NOT go through the JSON request() wrapper (it forces
  // application/json and the Worker would 400 on the multipart guard).
  const res = await fetch(`/api/records/${recordId}/attachments`, { method: "POST", body: fd });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { type?: string; message?: string } };
    throw new Error(body.error?.type ?? `HTTP ${res.status}`); // 413 / 415 carry a type the UI can map to copy
  }
  return (await res.json()) as AttachmentSummary;
}
```

The same-origin `fetch` sends the session cookie; if the app has a CSRF `Origin` check on non-GET requests (mazuoboeru-style `securityMiddleware`), multipart POSTs pass it like any other POST — the browser sets `Origin` on `fetch` regardless of body type.

## React usage (excerpt)

```tsx
function PhotoPicker({ recordId, onUploaded }: { recordId: string; onUploaded: (a: AttachmentSummary) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handle(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const prepared = await prepareImage(file);
      if (!prepared) {
        setError("この形式の写真はこの端末では読み込めません (HEIC の可能性)。JPEG で共有してください");
        return;
      }
      onUploaded(await uploadAttachment(recordId, prepared, file.name));
    } catch (e) {
      setError(e instanceof Error ? e.message : "upload failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Gallery OR camera. capture="environment" on the only input would hide "choose from library" on phones. */}
      <label>
        写真を選ぶ
        <input type="file" accept="image/*" disabled={busy} onChange={(e) => void handle(e.target.files)} />
      </label>
      <label>
        カメラで撮る
        <input type="file" accept="image/*" capture="environment" disabled={busy} onChange={(e) => void handle(e.target.files)} />
      </label>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
```

Render with the authenticated proxy URL — same origin, cookie goes along, no `crossorigin` attribute, no CSP change:

```tsx
<img src={`${a.url}?variant=thumb`} width={a.width ?? undefined} height={a.height ?? undefined} alt="" loading="lazy" />
```

Upload progress: `fetch` can't report upload progress; at ~300 KB per photo it is not worth an `XMLHttpRequest` path. Revisit only if users upload on 3G with visible stalls.
