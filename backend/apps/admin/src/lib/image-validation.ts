// Browser pre-check, mirroring the server gate in
// packages/api/src/api/admin/media/validate.ts. The SERVER is authoritative
// (it also magic-byte-sniffs and rejects animated frames); this just gives the
// operator instant feedback instead of a round-trip. KEEP THESE NUMBERS IN
// SYNC with validate.ts.

export type ImageKind = 'pack' | 'card' | 'sprite';

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
  }
> = {
  card: {
    minWidth: 600,
    minHeight: 840,
    targetRatio: 5 / 7,
    aspectTolerance: 0.03,
  },
  pack: {
    minWidth: 512,
    minHeight: 512,
    targetRatio: 1,
    aspectTolerance: 0.05,
  },
  sprite: {
    minWidth: 64,
    minHeight: 64,
    targetRatio: 1,
    aspectTolerance: 0.25,
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
  if (dim.width > MAX_DIMENSION || dim.height > MAX_DIMENSION) {
    return `Image is too large — keep each side ≤ ${MAX_DIMENSION}px.`;
  }

  const profile = PROFILES[kind];
  if (dim.width < profile.minWidth || dim.height < profile.minHeight) {
    const label = kind === 'card' ? 'Card' : kind === 'pack' ? 'Pack' : 'Sprite';
    return `${label} art must be at least ${profile.minWidth}×${profile.minHeight}px.`;
  }

  const ratio = dim.width / dim.height;
  const deviation = Math.abs(ratio - profile.targetRatio) / profile.targetRatio;
  if (deviation > profile.aspectTolerance) {
    return kind === 'card'
      ? 'Card art must be roughly 5:7 (portrait).'
      : 'Sprite/pack art must be roughly square (1:1).';
  }

  return null;
}
