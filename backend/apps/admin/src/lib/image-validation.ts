// Browser pre-check, mirroring the server gate in
// packages/api/src/api/admin/media/validate.ts. The SERVER is authoritative
// (it also magic-byte-sniffs and rejects animated frames); this just gives the
// operator instant feedback instead of a round-trip. KEEP THESE NUMBERS IN
// SYNC with validate.ts.

export type ImageKind =
  | 'pack'
  | 'display'
  | 'card'
  | 'sprite'
  | 'frame'
  | 'avatar-frame';

const ALLOWED_MIME = [
  'image/webp',
  'image/png',
  'image/jpeg',
  'image/avif',
  'image/gif',
];
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_DIMENSION = 8000;
const PROFILES: Record<
  ImageKind,
  {
    minWidth: number;
    minHeight: number;
    targetRatio: number;
    aspectTolerance: number;
    /** Optional per-profile cap; falls back to MAX_DIMENSION. */
    maxDimension?: number;
  }
> = {
  card: {
    minWidth: 600,
    minHeight: 840,
    targetRatio: 5 / 7,
    aspectTolerance: 0.03,
    // Mirrors validate.ts: card art is a composeSlab input decoded at 32 MP.
    maxDimension: 5500,
  },
  pack: {
    minWidth: 512,
    minHeight: 512,
    targetRatio: 1,
    aspectTolerance: 0.05,
  },
  // Pack-page hero scene — wide landscape (36:25 target, 16:9 admitted).
  display: {
    minWidth: 1280,
    minHeight: 720,
    targetRatio: 36 / 25,
    aspectTolerance: 0.25,
  },
  sprite: {
    minWidth: 64,
    minHeight: 64,
    targetRatio: 1,
    aspectTolerance: 0.25,
  },
  frame: {
    minWidth: 400,
    minHeight: 640,
    targetRatio: 0.62,
    aspectTolerance: 0.08,
    // Mirrors validate.ts: the slab frame is a composeSlab input decoded at 32 MP.
    maxDimension: 5500,
  },
  'avatar-frame': {
    minWidth: 256,
    minHeight: 256,
    targetRatio: 1,
    aspectTolerance: 0.05,
  },
};

function readDimensions(
  file: File,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('decode failed'));
    };
    img.src = url;
  });
}

// Returns null when the file passes, or a human-readable rejection message.
export async function validateImageFile(
  file: File,
  kind: ImageKind,
): Promise<string | null> {
  if (!ALLOWED_MIME.includes(file.type)) {
    return `Unsupported type ${file.type || 'unknown'}. Use WebP, PNG, JPEG, AVIF, or GIF.`;
  }
  if (file.size > MAX_BYTES) {
    return `File exceeds the ${Math.round(MAX_BYTES / (1024 * 1024))} MB limit.`;
  }

  let dim: { width: number; height: number };
  try {
    dim = await readDimensions(file);
  } catch {
    return 'Could not read the image — is it a valid image file?';
  }
  if (dim.width <= 0 || dim.height <= 0) {
    return 'Could not read the image dimensions.';
  }
  const profile = PROFILES[kind];
  const maxDim = profile.maxDimension ?? MAX_DIMENSION;
  if (dim.width > maxDim || dim.height > maxDim) {
    return `Image is too large — keep each side ≤ ${maxDim}px.`;
  }

  if (dim.width < profile.minWidth || dim.height < profile.minHeight) {
    const label =
      kind === 'card'
        ? 'Card'
        : kind === 'pack'
          ? 'Pack'
          : kind === 'display'
            ? 'Display'
            : kind === 'frame' || kind === 'avatar-frame'
              ? 'Frame'
              : 'Sprite';
    return `${label} art must be at least ${profile.minWidth}×${profile.minHeight}px.`;
  }

  const ratio = dim.width / dim.height;
  const deviation = Math.abs(ratio - profile.targetRatio) / profile.targetRatio;
  if (deviation > profile.aspectTolerance) {
    return kind === 'card'
      ? 'Card art must be roughly 5:7 (portrait).'
      : kind === 'display'
        ? 'Display art must be landscape (wider than tall, up to ~16:9).'
        : 'Sprite/pack art must be roughly square (1:1).';
  }

  return null;
}
