// Upload-validation gate. PURE + dependency-free so the unit suite drives it
// directly and so the same rules can be mirrored in the admin browser
// pre-check (apps/admin/src/lib/image-validation.ts — keep the numbers in
// sync; THIS file is the source of truth, the server is authoritative).
//
// The server passes the richest facts (sharp-detected format + frame count +
// real byte length); the browser passes only what it can cheaply read
// (declared type, size, decoded dimensions), so the sniff/animation gates are
// skipped client-side and enforced here.

// 'pc-card' is SERVER-INTERNAL (the PriceCharting image ingest) — the /admin/media
// route's kind allowlist deliberately excludes it, so a browser can never pick the
// relaxed profile. PriceCharting card photos are small (their largest variant often
// serves under 300px wide), so the curated 600×840 card minimum can't apply; the
// security gates (type sniff, byte cap, bomb guard) run unchanged.
export type ImageKind =
  | 'pack'
  | 'card'
  | 'sprite'
  | 'pc-card'
  | 'frame'
  | 'avatar'
  | 'avatar-frame'
  | 'delivery';

export interface ImageFacts {
  width: number;
  height: number;
  bytes: number;
  /** Declared MIME (browser file.type, or server file.mimetype). */
  mimeType: string;
  /** sharp metadata.format — server only; enables magic-byte sniffing. */
  detectedFormat?: string;
  /** sharp metadata.pages — server only; >1 means animated. */
  frames?: number;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: ValidationCode; message: string };

export type ValidationCode =
  | 'bad_type'
  | 'type_mismatch'
  | 'animated'
  | 'too_large'
  | 'unreadable'
  | 'too_big_dimension'
  | 'too_small'
  | 'bad_aspect';

// Allowed declared MIME → the sharp format string(s) those bytes decode to.
// Used both as the type allowlist and as the magic-byte consistency map.
const MIME_TO_FORMATS: Record<string, readonly string[]> = {
  'image/webp': ['webp'],
  'image/png': ['png'],
  'image/jpeg': ['jpeg', 'jpg'],
  'image/avif': ['avif', 'heif'], // sharp reports AVIF as "heif"
  'image/gif': ['gif'],
};

export interface ProfileRule {
  minWidth: number;
  minHeight: number;
  /** Target width/height ratio (card 5:7, pack 1:1). */
  targetRatio: number;
  /** Allowed relative deviation from targetRatio. */
  aspectTolerance: number;
}

export const IMAGE_RULES = {
  maxBytes: 20 * 1024 * 1024, // 20 MB — also enforced by multer at the edge
  maxDimension: 8000, // decompression-bomb / absurd-upload guard
  profiles: {
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
    // Pixel sprite: small + square-ish. Generous tolerance — pixel art is often
    // a few px off square; the storefront renders it object-contain regardless.
    sprite: {
      minWidth: 64,
      minHeight: 64,
      targetRatio: 1,
      aspectTolerance: 0.25,
    },
    // PriceCharting ingest (see ImageKind note): card-shaped but small. The min
    // only rejects degenerate/tracking-pixel responses, not real card photos.
    'pc-card': {
      minWidth: 96,
      minHeight: 128,
      targetRatio: 5 / 7,
      aspectTolerance: 0.25,
    },
    // Slab-frame overlay (site-settings): PSA-slab proportions (3.31" × 5.35"
    // ≈ 0.62), transparent card window. Tolerance admits hand-made frames a
    // few percent off; the storefront letterboxes object-contain regardless.
    frame: {
      minWidth: 400,
      minHeight: 640,
      targetRatio: 0.62,
      aspectTolerance: 0.08,
    },
    // Customer profile photo (store-side upload route): cropped to a circle
    // with object-cover on the storefront, so aspect is loose — reject only
    // degenerate strips (width/height outside [0.5, 1.5]).
    avatar: {
      minWidth: 64,
      minHeight: 64,
      targetRatio: 1,
      aspectTolerance: 0.5,
    },
    // Avatar-frame overlay (admin milestone frames, LV 10…100): a square ring
    // that layers over the round photo. Transparent PNG/WebP — or an AI render
    // with a flat magenta window (keyed on upload, same as 'frame').
    'avatar-frame': {
      minWidth: 256,
      minHeight: 256,
      targetRatio: 1,
      aspectTolerance: 0.05,
    },
    // Proof-of-delivery photo (operator-uploaded, shown to the customer). A real
    // phone photo in ANY orientation — so the aspect gate is deliberately loose
    // (tolerance 1.0 admits ~[0,2] ratios: portrait, landscape, 4:3, 16:9). The
    // security gates (type sniff, byte cap, bomb guard) still apply; the min just
    // rejects tracking-pixel-sized junk. ponytail: NOT the card 5:7 profile — a
    // 0.03-tolerance 5:7 gate would reject virtually every real delivery photo.
    delivery: {
      minWidth: 256,
      minHeight: 256,
      targetRatio: 1,
      aspectTolerance: 1.0,
    },
  } satisfies Record<ImageKind, ProfileRule>,
} as const;

const fail = (code: ValidationCode, message: string): ValidationResult => ({
  ok: false,
  code,
  message,
});

export function validateImage(
  facts: ImageFacts,
  kind: ImageKind,
): ValidationResult {
  const allowedFormats = MIME_TO_FORMATS[facts.mimeType];

  // 1 — declared type allowlist.
  if (!allowedFormats) {
    return fail(
      'bad_type',
      `Unsupported type ${facts.mimeType}. Use WebP, PNG, JPEG, AVIF, or GIF.`,
    );
  }

  // 2 — magic-byte sniff (server only): the real bytes must decode to a format
  // consistent with the declared MIME, so a renamed/disguised file is rejected.
  if (facts.detectedFormat && !allowedFormats.includes(facts.detectedFormat)) {
    return fail(
      'type_mismatch',
      `File contents (${facts.detectedFormat}) don't match the declared type ${facts.mimeType}.`,
    );
  }

  // 3 — no animated/multi-frame art (server only): we store a single image.
  if (facts.frames !== undefined && facts.frames > 1) {
    return fail(
      'animated',
      "Animated images aren't supported — upload a single frame.",
    );
  }

  // 4 — byte cap.
  if (facts.bytes > IMAGE_RULES.maxBytes) {
    const mb = Math.round(IMAGE_RULES.maxBytes / (1024 * 1024));
    return fail('too_large', `File exceeds the ${mb} MB limit.`);
  }

  // 5 — decodable.
  if (facts.width <= 0 || facts.height <= 0) {
    return fail('unreadable', 'Could not read the image dimensions.');
  }

  // 6 — upper dimension guard.
  if (
    facts.width > IMAGE_RULES.maxDimension ||
    facts.height > IMAGE_RULES.maxDimension
  ) {
    return fail(
      'too_big_dimension',
      `Image is too large — keep each side ≤ ${IMAGE_RULES.maxDimension}px.`,
    );
  }

  const profile = IMAGE_RULES.profiles[kind];

  // 7 — minimum resolution (no blurry upscaling on the storefront).
  if (facts.width < profile.minWidth || facts.height < profile.minHeight) {
    const label =
      kind === 'card' || kind === 'pc-card'
        ? 'Card'
        : kind === 'pack'
          ? 'Pack'
          : kind === 'avatar'
            ? 'Profile photo'
            : kind === 'avatar-frame' || kind === 'frame'
              ? 'Frame'
              : kind === 'delivery'
                ? 'Delivery photo'
                : 'Sprite';
    return fail(
      'too_small',
      `${label} art must be at least ${profile.minWidth}×${profile.minHeight}px.`,
    );
  }

  // 8 — aspect gate (card ~5:7, pack ~1:1).
  const ratio = facts.width / facts.height;
  const deviation = Math.abs(ratio - profile.targetRatio) / profile.targetRatio;
  if (deviation > profile.aspectTolerance) {
    return fail(
      'bad_aspect',
      kind === 'card' || kind === 'pc-card'
        ? 'Card art must be roughly 5:7 (portrait).'
        : kind === 'delivery'
          ? 'Delivery photo is too stretched — use a normal photo, not a panorama.'
          : 'Sprite/pack art must be roughly square (1:1).',
    );
  }

  return { ok: true };
}
