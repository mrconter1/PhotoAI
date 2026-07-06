// Pure helpers for loading, transforming and exporting images.
// Live adjustments are applied via CSS filters (GPU-accelerated) in the UI;
// these functions "bake" the current state into a fresh raster when committing.

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

export async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

/**
 * Bake transform + adjustments + crop into a new PNG data URL.
 * crop is in normalized coordinates relative to the *transformed* image.
 */
export function bake(
  img: HTMLImageElement,
  transform: Transform,
  adjustments: Adjustments,
  crop: CropRect | null
): string {
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

  const out = document.createElement("canvas");
  out.width = cw;
  out.height = ch;
  const octx = out.getContext("2d")!;
  // Place the full transformed buffer so the crop origin lands at (0,0).
  // A negative offset reveals transparent space (crop-out); a positive one trims.
  octx.drawImage(buffer, -cx, -cy);

  return out.toDataURL("image/png");
}

export function download(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
