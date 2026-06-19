import {
  validateImage,
  IMAGE_RULES,
  type ImageFacts,
} from "../validate";

// Pure upload-validation gate shared (in spirit) by the server route and the
// admin client pre-check. Server passes the richest facts (sharp-detected
// format + frame count + real byte length); the browser passes only what it
// can cheaply read (declared type, size, decoded dimensions). Every branch
// below is a reject the operator can hit, so each maps to one rule.

const card = (over: Partial<ImageFacts> = {}): ImageFacts => ({
  width: 1200,
  height: 1680, // exact 5:7
  bytes: 500_000,
  mimeType: "image/webp",
  detectedFormat: "webp",
  frames: 1,
  ...over,
});

const pack = (over: Partial<ImageFacts> = {}): ImageFacts => ({
  width: 1024,
  height: 1024, // square
  bytes: 500_000,
  mimeType: "image/png",
  detectedFormat: "png",
  frames: 1,
  ...over,
});

describe("validateImage — accepts valid art", () => {
  it("accepts a 5:7 card at/above min resolution", () => {
    expect(validateImage(card(), "card")).toEqual({ ok: true });
  });

  it("accepts a square pack at/above min resolution", () => {
    expect(validateImage(pack(), "pack")).toEqual({ ok: true });
  });

  it("accepts a card within the aspect tolerance band", () => {
    // 1200x1670 → ratio 0.7186 vs target 0.7143 (~0.6% off, inside ±3%).
    expect(validateImage(card({ height: 1670 }), "card").ok).toBe(true);
  });

  it("accepts when sniff-only facts are absent (browser path)", () => {
    const browserFacts = card({ detectedFormat: undefined, frames: undefined });
    expect(validateImage(browserFacts, "card")).toEqual({ ok: true });
  });
});

describe("validateImage — type gates", () => {
  it("rejects a disallowed declared mime", () => {
    const r = validateImage(card({ mimeType: "image/tiff", detectedFormat: "tiff" }), "card");
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe("bad_type");
  });

  it("rejects a magic-byte mismatch (declared png, bytes are gif)", () => {
    const r = validateImage(card({ mimeType: "image/png", detectedFormat: "gif" }), "card");
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe("type_mismatch");
  });

  it("rejects an animated/multi-frame image", () => {
    const r = validateImage(card({ mimeType: "image/gif", detectedFormat: "gif", frames: 12 }), "card");
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe("animated");
  });
});

describe("validateImage — size gates", () => {
  it("rejects bytes over the cap", () => {
    const r = validateImage(card({ bytes: IMAGE_RULES.maxBytes + 1 }), "card");
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe("too_large");
  });

  it("rejects an unreadable image (zero dimensions)", () => {
    const r = validateImage(card({ width: 0, height: 0 }), "card");
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe("unreadable");
  });

  it("rejects a dimension over the max (decompression-bomb guard)", () => {
    const r = validateImage(card({ width: IMAGE_RULES.maxDimension + 1, height: IMAGE_RULES.maxDimension + 1 }), "card");
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe("too_big_dimension");
  });
});

describe("validateImage — card profile", () => {
  it("rejects a card below min resolution", () => {
    const r = validateImage(card({ width: 400, height: 560 }), "card");
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe("too_small");
  });

  it("rejects a card outside the 5:7 aspect band", () => {
    const r = validateImage(card({ width: 1200, height: 1200 }), "card"); // square, not 5:7
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe("bad_aspect");
  });
});

describe("validateImage — pack profile", () => {
  it("rejects a pack below min resolution", () => {
    const r = validateImage(pack({ width: 256, height: 256 }), "pack");
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe("too_small");
  });

  it("rejects a non-square pack (banner-shaped upload)", () => {
    const r = validateImage(pack({ width: 1920, height: 1080 }), "pack");
    expect(r.ok).toBe(false);
    expect((r as { code: string }).code).toBe("bad_aspect");
  });
});

const facts = (w: number, h: number): ImageFacts => ({
  width: w, height: h, bytes: 1000, mimeType: 'image/png', detectedFormat: 'png', frames: 1,
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
