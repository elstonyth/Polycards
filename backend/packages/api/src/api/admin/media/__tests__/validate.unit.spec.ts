import { validateImage, IMAGE_RULES, type ImageFacts } from '../validate';

// Pure upload-validation gate shared (in spirit) by the server route and the
// admin client pre-check. Server passes the richest facts (sharp-detected
// format + frame count + real byte length); the browser passes only what it
// can cheaply read (declared type, size, decoded dimensions). Every branch
// below is a reject the operator can hit, so each maps to one rule.

const card = (over: Partial<ImageFacts> = {}): ImageFacts => ({
  width: 1200,
  height: 1680, // exact 5:7
  bytes: 500_000,
  mimeType: 'image/webp',
  detectedFormat: 'webp',
  frames: 1,
  ...over,
});

const pack = (over: Partial<ImageFacts> = {}): ImageFacts => ({
  width: 1024,
  height: 1024, // square
  bytes: 500_000,
  mimeType: 'image/png',
  detectedFormat: 'png',
  frames: 1,
  ...over,
});

describe('validateImage — accepts valid art', () => {
  it('accepts a 5:7 card at/above min resolution', () => {
    expect(validateImage(card(), 'card')).toEqual({ ok: true });
  });

  it('accepts a square pack at/above min resolution', () => {
    expect(validateImage(pack(), 'pack')).toEqual({ ok: true });
  });

  it('accepts a card within the aspect tolerance band', () => {
    // 1200x1670 → ratio 0.7186 vs target 0.7143 (~0.6% off, inside ±3%).
    expect(validateImage(card({ height: 1670 }), 'card').ok).toBe(true);
  });

  it('accepts when sniff-only facts are absent (browser path)', () => {
    const browserFacts = card({ detectedFormat: undefined, frames: undefined });
    expect(validateImage(browserFacts, 'card')).toEqual({ ok: true });
  });
});

describe('validateImage — type gates', () => {
  it('rejects a disallowed declared mime', () => {
    const r = validateImage(
      card({ mimeType: 'image/tiff', detectedFormat: 'tiff' }),
      'card',
    );
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('bad_type');
  });

  it('rejects a magic-byte mismatch (declared png, bytes are gif)', () => {
    const r = validateImage(
      card({ mimeType: 'image/png', detectedFormat: 'gif' }),
      'card',
    );
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('type_mismatch');
  });

  it('rejects an animated/multi-frame image', () => {
    const r = validateImage(
      card({ mimeType: 'image/gif', detectedFormat: 'gif', frames: 12 }),
      'card',
    );
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('animated');
  });
});

describe('validateImage — size gates', () => {
  it('rejects bytes over the cap', () => {
    const r = validateImage(card({ bytes: IMAGE_RULES.maxBytes + 1 }), 'card');
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('too_large');
  });

  it('rejects an unreadable image (zero dimensions)', () => {
    const r = validateImage(card({ width: 0, height: 0 }), 'card');
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('unreadable');
  });

  it('rejects a dimension over the max (decompression-bomb guard)', () => {
    const r = validateImage(
      card({
        width: IMAGE_RULES.maxDimension + 1,
        height: IMAGE_RULES.maxDimension + 1,
      }),
      'card',
    );
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('too_big_dimension');
  });
});

describe('validateImage — card profile', () => {
  it('rejects a card below min resolution', () => {
    const r = validateImage(card({ width: 400, height: 560 }), 'card');
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('too_small');
  });

  it('rejects a card outside the 5:7 aspect band', () => {
    const r = validateImage(card({ width: 1200, height: 1200 }), 'card'); // square, not 5:7
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('bad_aspect');
  });
});

describe('validateImage — pack profile', () => {
  it('rejects a pack below min resolution', () => {
    const r = validateImage(pack({ width: 256, height: 256 }), 'pack');
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('too_small');
  });

  it('rejects a non-square pack (banner-shaped upload)', () => {
    const r = validateImage(pack({ width: 1920, height: 1080 }), 'pack');
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('bad_aspect');
  });
});

const facts = (w: number, h: number): ImageFacts => ({
  width: w,
  height: h,
  bytes: 1000,
  mimeType: 'image/png',
  detectedFormat: 'png',
  frames: 1,
});

describe('validateImage — display profile (pack-page hero)', () => {
  const display = (over: Partial<ImageFacts> = {}): ImageFacts => ({
    width: 2560,
    height: 1778, // 36:25 target
    bytes: 500_000,
    mimeType: 'image/webp',
    detectedFormat: 'webp',
    frames: 1,
    ...over,
  });

  it('accepts the 36:25 target and a 16:9 render', () => {
    expect(validateImage(display(), 'display')).toEqual({ ok: true });
    expect(
      validateImage(display({ width: 1920, height: 1080 }), 'display'),
    ).toEqual({ ok: true });
  });

  it('allows animated/multi-frame art (the hero is meant to move)', () => {
    expect(validateImage(display({ frames: 12 }), 'display')).toEqual({
      ok: true,
    });
  });

  it('rejects below the 1280×720 minimum', () => {
    const r = validateImage(display({ width: 1024, height: 700 }), 'display');
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('too_small');
  });

  it('rejects portrait/square art (not a wide scene)', () => {
    const r = validateImage(display({ width: 1440, height: 1440 }), 'display');
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('bad_aspect');
  });
});

describe('validateImage — sprite profile', () => {
  it('accepts a square pixel sprite', () => {
    expect(validateImage(facts(96, 96), 'sprite')).toEqual({ ok: true });
  });
  it('accepts a small near-square sprite', () => {
    expect(validateImage(facts(64, 64), 'sprite')).toEqual({ ok: true });
  });
  it('rejects a portrait card-shaped image under the sprite profile', () => {
    const r = validateImage(facts(600, 840), 'sprite');
    expect(r.ok).toBe(false);
  });
});

describe('validateImage — avatar profile decode-DoS dimension cap', () => {
  const avatar = (w: number, h: number): ImageFacts => ({
    width: w,
    height: h,
    bytes: 200_000,
    mimeType: 'image/png',
    detectedFormat: 'png',
    frames: 1,
  });

  it('accepts a normally-sized avatar', () => {
    expect(validateImage(avatar(512, 512), 'avatar')).toEqual({ ok: true });
  });

  it('rejects an oversized avatar far under the shared 8000 cap (decode-DoS guard)', () => {
    // An 8000x8000 (64 MP) avatar previously passed (8000 is not > the shared
    // 8000 bomb guard), and the route then ran a full sharp decode+webp on it —
    // a single-request CPU/RAM DoS. The customer avatar profile must cap far
    // tighter than the shared admin-media decompression-bomb guard.
    const r = validateImage(avatar(8000, 8000), 'avatar');
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('too_big_dimension');
  });

  it('caps the avatar at 2048px per side (boundary: 2048 ok, 2049 rejected)', () => {
    expect(validateImage(avatar(2048, 2048), 'avatar')).toEqual({ ok: true });
    const over = validateImage(avatar(2049, 2049), 'avatar');
    expect(over.ok).toBe(false);
    expect((over as { code: string }).code).toBe('too_big_dimension');
  });

  it('leaves profiles without a per-profile cap on the shared 8000 bound', () => {
    // Regression guard: 'pack' declares no maxDimension → global bound applies.
    expect(validateImage(pack({ width: 4000, height: 4000 }), 'pack')).toEqual({
      ok: true,
    });
  });
});

describe('validateImage — frame/card caps align with the slab-bake ceiling', () => {
  // composeSlab decodes the frame + card photo at limitInputPixels 32 MP. A
  // profile that allowed the shared 8000px per side (64 MP) would pass here and
  // then SILENTLY fail to bake (bakeSlabImage is best-effort). Cap each side so
  // maxDimension² stays under that ceiling.
  it('still accepts the legit large frame the bake path downscales (3200×5352)', () => {
    expect(validateImage(facts(3200, 5352), 'frame')).toEqual({ ok: true });
  });

  // Dimensions here sit UNDER the shared 8000 bound so they isolate the
  // per-profile cap (4960×8000 = 39.7 MP is a frame that passes today yet blows
  // composeSlab's 32 MP decode ceiling — the silent-bake-failure gap).
  it('rejects a frame above the per-profile cap', () => {
    const r = validateImage(facts(4340, 7000), 'frame'); // 0.62 ratio, < 8000
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('too_big_dimension');
  });

  it('rejects a card above the per-profile cap', () => {
    const r = validateImage(facts(5000, 7000), 'card'); // 5:7 ratio, < 8000
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe('too_big_dimension');
  });
});
