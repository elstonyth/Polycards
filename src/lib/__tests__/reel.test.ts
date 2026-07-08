import { describe, it, expect, test } from 'vitest';
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
  reelPaintX,
} from '@/lib/reel';
import { spinOffset, spinTotalMs, columnDurationMs } from '@/lib/vault-reel';
import type { Rarity } from '@/lib/packs-data';

const POOL: Rarity[] = ['Legendary', 'Mythical', 'Rare', 'Uncommon', 'Common'];

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
    const strip = buildStrip('Mythical', POOL, STRIP_LEN, WIN_INDEX);
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

describe('reelPaintX (horizontal right→left reflection)', () => {
  test('lands exactly on target when the spin ends', () => {
    expect(reelPaintX(3000, 3000)).toBe(3000);
  });
  test('starts LEFT of target (winner enters from the right)', () => {
    // spinOffset starts HIGH (> target); reflected paint is BELOW target
    expect(reelPaintX(5000, 3000)).toBeLessThan(3000);
  });
  test('rises as the spin offset falls (cells travel left)', () => {
    expect(reelPaintX(4000, 3000)).toBeGreaterThan(reelPaintX(5000, 3000));
    expect(reelPaintX(3000, 3000)).toBeGreaterThan(reelPaintX(4000, 3000));
  });
  test('symmetric around target — a downward overshoot paints a LEFT overshoot', () => {
    expect(reelPaintX(2900, 3000)).toBe(3100);
  });
});

describe('horizontal spin (reflection + real physics)', () => {
  const pitch = ITEM_W;
  const winW = pitch * 5;
  const target = reelTarget(WIN_INDEX, pitch, winW);

  test('winner starts right of center and settles centered', () => {
    const startPaint = reelPaintX(spinOffset(0, target, 0, 1, pitch), target);
    const endPaint = reelPaintX(
      spinOffset(spinTotalMs(1), target, 0, 1, pitch),
      target,
    );
    expect(startPaint).toBeLessThan(endPaint); // right→left
    expect(endPaint).toBe(target);
  });

  // Bounds at the pitches that ACTUALLY run: ReelStrip uses
  // pitch = round(cellSize·CARD_ASPECT) + 10 ≈ 64 (cellSize 76) or 79
  // (cellSize 96) — not ITEM_W (124). The invariant is linear in pitch so 124
  // passing implies the smaller pitches do, but exercise the real values.
  test('the whole reflected travel stays inside the strip at real pitches', () => {
    for (const p of [64, 79, ITEM_W]) {
      const w = p * 5;
      const tgt = reelTarget(WIN_INDEX, p, w);
      const maxOffset = STRIP_LEN * p - w;
      for (const [col, count] of [
        [0, 1],
        [0, 3],
        [2, 3],
      ] as const) {
        const dur = columnDurationMs(col, count);
        for (let t = 0; t <= dur; t += 8) {
          const px = reelPaintX(spinOffset(t, tgt, col, count, p), tgt);
          expect(px).toBeGreaterThanOrEqual(-0.001);
          expect(px).toBeLessThanOrEqual(maxOffset + 0.001);
        }
      }
    }
  });
});

describe('gapped winner centering (winning-line alignment)', () => {
  test('a gapped winner cell lands centered on the window center', () => {
    // ReelStrip lays cells out with a flex gap: pitch = cellW + gap, and the
    // settle target subtracts gap/2 so the CELL center (not the pitch center)
    // sits on the winning line. Assert that across representative cell sizes.
    for (const cellW of [64, 68, 79]) {
      const gap = 10;
      const pitch = cellW + gap;
      const winW = pitch * 5;
      const target = reelTarget(WIN_INDEX, pitch, winW) - gap / 2;
      // cell WIN_INDEX center on screen after translateX(-target):
      const cellCenterOnScreen = WIN_INDEX * pitch + cellW / 2 - target;
      expect(cellCenterOnScreen).toBeCloseTo(winW / 2, 6);
    }
  });
});
