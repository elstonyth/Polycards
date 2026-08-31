import { describe, expect, it } from 'vitest';
import {
  isGraded,
  slabAmbient,
  slabGlowRgb,
  VARIANT_RGB,
} from '@/components/SlabImage';
import { RARITY_RGB } from '@/lib/rarity';

// SlabImage now owns the colour + ambient bloom that /card and the reveal used
// to spell out themselves. The consolidation is only honest if it emits the
// SAME strings those call sites emitted — a shifted radius or a Common-gray
// where white used to be is invisible in review and only shows up as a slab
// that "looks a bit off". These pin the exact values.
describe('slabGlowRgb', () => {
  it('takes the rarity colour, and lets a variant override it', () => {
    expect(slabGlowRgb('Immortal')).toBe(RARITY_RGB.Immortal);
    expect(slabGlowRgb('Immortal', 'prism')).toBe(VARIANT_RGB.prism);
    // A variant frames the slab on its own — no rarity needed at the call site.
    expect(slabGlowRgb(null, 'prism')).toBe(VARIANT_RGB.prism);
  });

  it('falls back to Common for a null/unknown rarity, never to white', () => {
    // CardDetail's ambient bloom uses white for a card with NO rarity, because
    // SlabImage draws no band there at all. That fallback lives at the call
    // site precisely because this one is gray — if this ever returns white the
    // two are silently merged.
    expect(slabGlowRgb(null)).toBe(RARITY_RGB.Common);
    expect(slabGlowRgb('Nonsense')).toBe(RARITY_RGB.Common);
  });
});

describe('slabAmbient', () => {
  it('emits the card page bloom byte-for-byte', () => {
    expect(slabAmbient('hero', '1,2,3')).toBe(
      'drop-shadow(0 24px 60px rgba(0,0,0,0.7)) drop-shadow(0 0 46px rgba(1,2,3,0.28))',
    );
  });

  it('emits the reveal bloom byte-for-byte', () => {
    expect(slabAmbient('reveal', '1,2,3')).toBe(
      'drop-shadow(0 18px 30px rgba(0,0,0,0.6)) drop-shadow(0 0 26px rgba(1,2,3,0.35))',
    );
  });
});

describe('isGraded', () => {
  it('is the bake-result test, not a pack-type test', () => {
    expect(isGraded('https://cdn/slab.webp')).toBe(true);
    expect(isGraded(null)).toBe(false);
    expect(isGraded(undefined)).toBe(false);
    expect(isGraded('')).toBe(false); // a failed bake reads as raw
  });
});
