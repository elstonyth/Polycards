/**
 * Avatar crop → upload-ready file.
 *
 * WHY this exists (2026-07-19): customers reported "upload failed" with no
 * useful reason. A stock phone photo is 4032×3024 and the backend's avatar
 * profile caps each side at 2048px (a deliberate decode-cost guard, see
 * backend .../admin/media/validate.ts) and the aspect at ~[0.5, 1.5] — so a
 * normal photo, and every landscape/panorama screenshot, was rejected server
 * side. Cropping in the browser and exporting a small SQUARE image makes every
 * upload satisfy those gates by construction, so the caps stay untouched.
 *
 * Output: OUTPUT_PX square WebP (JPEG on browsers whose canvas can't encode
 * WebP), which is also what the backend re-encodes to.
 */

/** Pixel rect react-easy-crop reports (`croppedAreaPixels`). */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Stored square edge. 512 covers the largest avatar we render (128 CSS px at
 *  3× DPR) and keeps the upload well under every size gate. */
export const OUTPUT_PX = 512;

/**
 * Clamp a crop rect into the source image, KEEPING IT SQUARE. react-easy-crop
 * reports fractional pixels that round a hair past the edge; drawImage()
 * silently fills such out-of-bounds source pixels with transparency, which
 * shows up as a translucent sliver along one side of the avatar. Squareness
 * matters because the result is drawn into a square canvas — trimming one side
 * only would stretch the photo.
 */
export function clampRect(
  rect: CropRect,
  sourceWidth: number,
  sourceHeight: number,
): CropRect {
  const side = Math.max(
    1,
    Math.min(
      Math.round(rect.width),
      Math.round(rect.height),
      sourceWidth,
      sourceHeight,
    ),
  );
  return {
    x: Math.max(0, Math.min(Math.round(rect.x), sourceWidth - side)),
    y: Math.max(0, Math.min(Math.round(rect.y), sourceHeight - side)),
    width: side,
    height: side,
  };
}

/** Load an object URL into a decoded <img>. Rejects on formats the browser
 *  can't decode (a .heic picked on desktop Chrome is the realistic case). */
export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('decode_failed'));
    img.src = src;
  });
}

/**
 * Draw the cropped square and encode it. Browsers apply EXIF orientation when
 * rendering an <img> (image-orientation: from-image is the default), and
 * drawImage inherits that, so the exported pixels are already upright — no
 * separate EXIF pass. Re-encoding also drops the photo's metadata (phone
 * photos often carry GPS) before it ever leaves the device.
 */
export async function cropToFile(
  image: HTMLImageElement,
  rect: CropRect,
): Promise<File> {
  const area = clampRect(rect, image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = OUTPUT_PX;
  canvas.height = OUTPUT_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas_unavailable');
  // Matte transparency to white: the JPEG fallback below has no alpha channel,
  // and an unfilled canvas would turn a transparent PNG's background black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, OUTPUT_PX, OUTPUT_PX);
  ctx.drawImage(
    image,
    area.x,
    area.y,
    area.width,
    area.height,
    0,
    0,
    OUTPUT_PX,
    OUTPUT_PX,
  );

  // WebP first (smallest); toBlob hands back null for a type it can't encode,
  // so fall back to JPEG — both are on the backend's allowlist.
  const blob =
    (await toBlob(canvas, 'image/webp')) ??
    (await toBlob(canvas, 'image/jpeg'));
  if (!blob) throw new Error('encode_failed');
  const ext = blob.type === 'image/webp' ? 'webp' : 'jpg';
  return new File([blob], `avatar.${ext}`, { type: blob.type });
}

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((b) => resolve(b && b.type === type ? b : null), type, 0.9);
  });
}
