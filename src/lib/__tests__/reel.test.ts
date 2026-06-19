import { describe, it, expect } from 'vitest';
import {
  reelTarget,
  buildStrip,
  ITEM_W,
  STRIP_LEN,
  WIN_INDEX,
  reelTargetY,
  buildDexStrip,
  ITEM_H,
  POKEDEX_MAX,
} from '@/lib/reel';
import type { Rarity } from '@/app/claw/packs-data';

const POOL: Rarity[] = ['Legendary', 'Epic', 'Rare', 'Uncommon', 'Common'];

describe('reelTarget', () => {
  it('centers the winner index under the payline', () => {
    // 36*124 + 124/2 - 600/2 = 4464 + 62 - 300 = 4226
    expect(reelTarget(36, 124, 600)).toBe(4226);
  });

  it('shifts left as the window widens (winner stays centered)', () => {
    expect(reelTarget(36, 124, 800)).toBe(reelTarget(36, 124, 600) - 100);
  });

  it('uses the shipped constants by default geometry', () => {
    expect(ITEM_W).toBe(124);
    expect(WIN_INDEX).toBe(36);
    expect(STRIP_LEN).toBe(48);
  });
});

describe('buildStrip', () => {
  it('places the winner rarity exactly at WIN_INDEX', () => {
    const strip = buildStrip('Legendary', POOL, STRIP_LEN, WIN_INDEX);
    expect(strip).toHaveLength(STRIP_LEN);
    expect(strip[WIN_INDEX]).toBe('Legendary');
  });

  it('fills every non-winner cell from the pool', () => {
    const strip = buildStrip('Epic', POOL, STRIP_LEN, WIN_INDEX);
    strip.forEach((r, i) => {
      if (i !== WIN_INDEX) expect(POOL).toContain(r);
    });
  });

  it('is deterministic for the same inputs', () => {
    expect(buildStrip('Rare', POOL, STRIP_LEN, WIN_INDEX)).toEqual(
      buildStrip('Rare', POOL, STRIP_LEN, WIN_INDEX),
    );
  });

  it('throws when winIndex is out of bounds', () => {
    expect(() => buildStrip('Rare', POOL, STRIP_LEN, STRIP_LEN)).toThrow(
      RangeError,
    );
    expect(() => buildStrip('Rare', POOL, STRIP_LEN, -1)).toThrow(RangeError);
  });

  it('throws when length is not a positive integer', () => {
    expect(() => buildStrip('Rare', POOL, 0, 0)).toThrow(RangeError);
  });
});

describe('reelTargetY', () => {
  it('centers the winner index under a horizontal payline', () => {
    // 36*112 + 112/2 - 600/2 = 4032 + 56 - 300 = 3788
    expect(reelTargetY(36, 112, 600)).toBe(3788);
  });
  it('shifts up as the window grows taller (winner stays centered)', () => {
    expect(reelTargetY(36, 112, 800)).toBe(reelTargetY(36, 112, 600) - 100);
  });
  it('uses ITEM_H = 112 by default geometry', () => {
    expect(ITEM_H).toBe(112);
  });
});

describe('buildDexStrip', () => {
  it('pins the winner dex exactly at WIN_INDEX', () => {
    const strip = buildDexStrip(150, STRIP_LEN, WIN_INDEX);
    expect(strip).toHaveLength(STRIP_LEN);
    expect(strip[WIN_INDEX]).toBe(150);
  });
  it('keeps every cell within [1, POKEDEX_MAX]', () => {
    buildDexStrip(150, STRIP_LEN, WIN_INDEX).forEach((d) => {
      expect(d).toBeGreaterThanOrEqual(1);
      expect(d).toBeLessThanOrEqual(POKEDEX_MAX);
    });
  });
  it('clamps an out-of-range winner to dex 1', () => {
    expect(buildDexStrip(0, STRIP_LEN, WIN_INDEX)[WIN_INDEX]).toBe(1);
    expect(buildDexStrip(99999, STRIP_LEN, WIN_INDEX)[WIN_INDEX]).toBe(1);
  });
  it('is deterministic for the same inputs', () => {
    expect(buildDexStrip(25, STRIP_LEN, WIN_INDEX)).toEqual(
      buildDexStrip(25, STRIP_LEN, WIN_INDEX),
    );
  });
  it('throws when winIndex is out of bounds', () => {
    expect(() => buildDexStrip(25, STRIP_LEN, STRIP_LEN)).toThrow(RangeError);
    expect(() => buildDexStrip(25, STRIP_LEN, -1)).toThrow(RangeError);
    expect(() => buildDexStrip(25, STRIP_LEN, 1.5)).toThrow(RangeError);
  });
  it('throws when length is not a positive integer', () => {
    expect(() => buildDexStrip(25, 0, 0)).toThrow(RangeError);
    expect(() => buildDexStrip(25, 2.5, 0)).toThrow(RangeError);
  });
});
