// Pure helpers for loading, transforming and exporting images.
// Live adjustments are applied via CSS filters (GPU-accelerated) in the UI;
// these functions "bake" the current state into a fresh raster when committing.
//
// Everything here deals in *object URLs* (blob:) rather than base64 data URLs.
// A 24 MP photo is ~30 MB as a PNG blob and another ~40 MB on top of that as a
// base64 string, so a handful of edits on a large photo used to be enough to
// exhaust the tab. Blobs are held by the browser (and spilled to disk), and can
// be released with revoke().

export type Adjustments = {
  brightness: number; // %  (100 = neutral)
  contrast: number; // %
  saturation: number; // %
  sepia: number; // %
  grayscale: number; // %
};

export const NEUTRAL_ADJUSTMENTS: Adjustments = {
  brightness: 100,
  contrast: 100,
  saturation: 100,
  sepia: 0,
  grayscale: 0,
};

export type Transform = {
  rotate: number; // degrees, multiples of 90
  flipH: boolean;
  flipV: boolean;
};

export const IDENTITY_TRANSFORM: Transform = { rotate: 0, flipH: false, flipV: false };

// Normalized crop rect relative to the image. Values may fall OUTSIDE 0..1
// to crop "out" — i.e. extend the canvas beyond the current photo (the extra
// area becomes transparent margin).
export type CropRect = { x: number; y: number; w: number; h: number };

// ---- large-image limits ----------------------------------------------------

// Browsers cap 2D canvases: ~16384 px per side plus a total area limit that is
// 268 MP on desktop Chrome but far lower on mobile Safari. Going over does not
// throw — the canvas simply comes back blank — so anything bigger is downscaled
// once, on open, and the editor works on that copy.
export const MAX_CANVAS_EDGE = 16384;
export const MAX_CANVAS_PIXELS = 64_000_000; // 64 MP, comfortably inside every engine

// Longest edge sent to the image model, per requested output resolution.
// Sending the full original buys nothing (the models work at 1-4K internally),
// costs upload time, and can breach the request size limit on the Google API.
export const AI_MAX_EDGE: Record<string, number> = {
  "": 2048, // model default
  "1K": 1536,
  "2K": 2048,
  "4K": 3072,
};

// Target size for the encoded upload. Measured against the deployment: a body
// over 4.5 MB is refused by the platform with FUNCTION_PAYLOAD_TOO_LARGE before
// the route ever runs, so this leaves room for the multipart envelope on top.
export const AI_MAX_UPLOAD_BYTES = 3.5 * 1024 * 1024;

/** Scale factor (<= 1) that brings w x h inside the canvas budget. */
export function canvasFitScale(w: number, h: number): number {
  const byEdge = Math.min(1, MAX_CANVAS_EDGE / Math.max(w, h));
  const byArea = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, w * h)));
  return Math.min(byEdge, byArea);
}

/** Release an object URL. Safe to call with null or with a non-blob URL. */
export function revoke(url: string | null | undefined) {
  if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
}

export function adjustmentsToFilter(a: Adjustments): string {
  return [
    `brightness(${a.brightness}%)`,
    `contrast(${a.contrast}%)`,
    `saturate(${a.saturation}%)`,
    `sepia(${a.sepia}%)`,
    `grayscale(${a.grayscale}%)`,
  ].join(" ");
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Failed to load image."));
    img.src = src;
  });
}

export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type = "image/png",
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Could not encode the image - it may be too large for this browser."));
      },
      type,
      quality
    );
  });
}

/** Encode a canvas as PNG and hand back an object URL the caller now owns. */
export async function canvasToUrl(canvas: HTMLCanvasElement): Promise<string> {
  return URL.createObjectURL(await canvasToBlob(canvas, "image/png"));
}

/**
 * Open a picked or dropped file as an editable image.
 * The file is referenced directly (no base64 round trip), and downscaled once
 * if it is larger than a canvas can hold - otherwise every later bake would
 * silently produce a blank frame.
 */
export async function openImageFile(
  file: File
): Promise<{ url: string; img: HTMLImageElement; scaledFrom: { w: number; h: number } | null }> {
  if (file.type && !file.type.startsWith("image/")) {
    throw new Error(`${file.name || "That file"} is not an image.`);
  }

  const url = URL.createObjectURL(file);
  let img: HTMLImageElement;
  try {
    img = await loadImage(url);
  } catch (e) {
    revoke(url);
    throw e;
  }

  const scale = canvasFitScale(img.naturalWidth, img.naturalHeight);
  if (scale >= 1) return { url, img, scaledFrom: null };

  const from = { w: img.naturalWidth, h: img.naturalHeight };
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(from.w * scale));
  canvas.height = Math.max(1, Math.round(from.h * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  const smallUrl = await canvasToUrl(canvas);
  revoke(url); // the original raster is no longer referenced
  return { url: smallUrl, img: await loadImage(smallUrl), scaledFrom: from };
}

/**
 * Bake transform + adjustments + crop into a new canvas.
 * crop is in normalized coordinates relative to the *transformed* image, and
 * may reach outside 0..1 to extend the frame (those margins stay transparent).
 */
export function bake(
  img: HTMLImageElement,
  transform: Transform,
  adjustments: Adjustments,
  crop: CropRect | null
): HTMLCanvasElement {
  const rotated = transform.rotate % 180 !== 0;
  const tW = rotated ? img.naturalHeight : img.naturalWidth;
  const tH = rotated ? img.naturalWidth : img.naturalHeight;

  // 1) render transformed + filtered image to a full-size buffer
  const buffer = document.createElement("canvas");
  buffer.width = tW;
  buffer.height = tH;
  const bctx = buffer.getContext("2d")!;
  bctx.filter = adjustmentsToFilter(adjustments);
  bctx.save();
  bctx.translate(tW / 2, tH / 2);
  bctx.rotate((transform.rotate * Math.PI) / 180);
  bctx.scale(transform.flipH ? -1 : 1, transform.flipV ? -1 : 1);
  bctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  bctx.restore();

  // 2) crop — may extend beyond the image; margins stay transparent
  const c = crop ?? { x: 0, y: 0, w: 1, h: 1 };
  const cx = Math.round(c.x * tW);
  const cy = Math.round(c.y * tH);
  const cw = Math.max(1, Math.round(c.w * tW));
  const ch = Math.max(1, Math.round(c.h * tH));

  // A generous crop-out can push the result past the canvas budget; keep it in.
  const s = canvasFitScale(cw, ch);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(cw * s));
  out.height = Math.max(1, Math.round(ch * s));
  const octx = out.getContext("2d")!;
  octx.imageSmoothingQuality = "high";
  if (s < 1) octx.scale(s, s);
  // Place the full transformed buffer so the crop origin lands at (0,0).
  // A negative offset reveals transparent space (crop-out); a positive one trims.
  octx.drawImage(buffer, -cx, -cy);

  return out;
}

/** bake() straight to an object URL. */
export async function bakeToUrl(
  img: HTMLImageElement,
  transform: Transform,
  adjustments: Adjustments,
  crop: CropRect | null
): Promise<string> {
  return canvasToUrl(bake(img, transform, adjustments, crop));
}

/**
 * Downscale and compress an image for the AI round trip.
 * WebP is used because it is the one format that is both small and keeps the
 * alpha a crop-out leaves behind (JPEG would fill it black); Gemini accepts it.
 * Quality steps down until the blob fits maxBytes.
 */
export async function encodeForUpload(
  img: HTMLImageElement,
  maxEdge = AI_MAX_EDGE[""],
  maxBytes = AI_MAX_UPLOAD_BYTES
): Promise<{ blob: Blob; width: number; height: number }> {
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  let blob = await canvasToBlob(canvas, "image/webp", 0.92);
  for (const q of [0.8, 0.7, 0.6, 0.5]) {
    if (blob.size <= maxBytes) break;
    blob = await canvasToBlob(canvas, "image/webp", q);
  }

  // Last resort for a browser without WebP encoding, or a stubbornly big frame:
  // shrink the pixels until it fits rather than failing the request outright.
  let guard = 0;
  while (blob.size > maxBytes && guard++ < 4 && canvas.width > 512) {
    const w = Math.max(1, Math.round(canvas.width * 0.75));
    const h = Math.max(1, Math.round(canvas.height * 0.75));
    const small = document.createElement("canvas");
    small.width = w;
    small.height = h;
    const sctx = small.getContext("2d")!;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(canvas, 0, 0, w, h);
    canvas.width = w;
    canvas.height = h;
    ctx.drawImage(small, 0, 0);
    blob = await canvasToBlob(canvas, "image/webp", 0.8);
  }

  return { blob, width: canvas.width, height: canvas.height };
}

export function download(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
