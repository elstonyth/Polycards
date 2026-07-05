import { describe, expect, test } from 'vitest';
import {
  WINDUP_MS,
  BLUR_MS,
  FRICTION_MS,
  CRAWL_MS,
  SETTLE_MS,
  STOP_STAGGER_MS,
  VISIBLE_CELLS,
  VAULT_WIN_INDEX,
  columnDurationMs,
  spinTotalMs,
  spinOffset,
  cellCurve,
  blurStretch,
  buildVaultStrip,
} from '@/lib/vault-reel';
import { ITEM_H as REEL_ITEM_H, STRIP_LEN, reelTargetY } from '@/lib/reel';

const ITEM_H = 112;
const TARGET = 3000;

describe('columnDurationMs', () => {
  test('non-last column has no crawl phase', () => {
    expect(columnDurationMs(0, 3)).toBe(
      WINDUP_MS + BLUR_MS + FRICTION_MS + SETTLE_MS,
    );
  });
  test('last column adds crawl', () => {
    expect(columnDurationMs(2, 3)).toBe(
      WINDUP_MS +
        BLUR_MS +
        FRICTION_MS +
        CRAWL_MS +
        SETTLE_MS +
        2 * STOP_STAGGER_MS,
    );
  });
  test('single column IS the last column (crawl included)', () => {
    expect(columnDurationMs(0, 1)).toBe(
      WINDUP_MS + BLUR_MS + FRICTION_MS + CRAWL_MS + SETTLE_MS,
    );
  });
  test('stagger extends duration per column index', () => {
    expect(columnDurationMs(1, 3) - columnDurationMs(0, 3)).toBe(
      STOP_STAGGER_MS,
    );
  });
});

describe('spinTotalMs', () => {
  test('equals the last column duration', () => {
    expect(spinTotalMs(3)).toBe(columnDurationMs(2, 3));
    expect(spinTotalMs(1)).toBe(columnDurationMs(0, 1));
  });

  // Spec decision #33 (a): a touch longer than the old ~2.86s / ~3.64s, but
  // still snappy — a range, not exact constants, so retunes don't churn tests.
  test('a single-reel spin runs ~3.5s (longer than before, still under 4s)', () => {
    expect(columnDurationMs(0, 1)).toBeGreaterThan(3200);
    expect(columnDurationMs(0, 1)).toBeLessThan(4000);
  });
  test('a 3-reel spin lands ~4.3s (longer than before, still under 5s)', () => {
    expect(spinTotalMs(3)).toBeGreaterThan(4000);
    expect(spinTotalMs(3)).toBeLessThan(5000);
  });
});

describe('spinOffset', () => {
  // Direction contract (spec decision #22): cells stream TOP → BOTTOM. The
  // winner starts ABOVE the payline (offset HIGH = target + pre-roll travel) and
  // DESCENDS to `target` (offset falls). Wind-up pulls UP (offset spikes above
  // the start), settle overshoots BELOW the target (offset dips under it).
  test('starts HIGH (above the target) and ends exactly at target', () => {
    const start = spinOffset(0, TARGET, 0, 1, ITEM_H);
    expect(start).toBeGreaterThan(TARGET); // winner begins above the payline
    expect(spinOffset(spinTotalMs(1), TARGET, 0, 1, ITEM_H)).toBe(TARGET);
    expect(spinOffset(spinTotalMs(1) + 5000, TARGET, 0, 1, ITEM_H)).toBe(
      TARGET,
    );
  });
  test('wind-up pulls UP: offset rises ABOVE the start position', () => {
    const start = spinOffset(0, TARGET, 0, 1, ITEM_H);
    const mid = spinOffset(WINDUP_MS / 2, TARGET, 0, 1, ITEM_H);
    // pulled up by up to half a cell beyond the start
    expect(mid).toBeGreaterThan(start);
    expect(mid).toBeLessThanOrEqual(start + ITEM_H / 2 + 0.001);
  });
  test('monotonically DECREASING (cells descend) after wind-up until settle', () => {
    const dur = columnDurationMs(0, 1);
    let prev = spinOffset(WINDUP_MS, TARGET, 0, 1, ITEM_H);
    for (let t = WINDUP_MS + 16; t <= dur - SETTLE_MS; t += 16) {
      const cur = spinOffset(t, TARGET, 0, 1, ITEM_H);
      expect(cur).toBeLessThanOrEqual(prev + 0.001);
      prev = cur;
    }
  });
  test('settle overshoots BELOW target by at most 0.6 cells', () => {
    const dur = columnDurationMs(0, 1);
    let minSeen = Infinity;
    for (let t = dur - SETTLE_MS; t <= dur; t += 8) {
      minSeen = Math.min(minSeen, spinOffset(t, TARGET, 0, 1, ITEM_H));
    }
    expect(minSeen).toBeLessThan(TARGET); // it does overshoot (downward)
    expect(minSeen).toBeGreaterThanOrEqual(TARGET - ITEM_H * 0.6);
  });

  // Spec decision #33 (b): the settle must EASE IN from the friction/crawl's
  // near-zero arrival velocity — no instantaneous velocity kick at the landing
  // (that jerk was the "sudden stop"). Sample the instantaneous velocity right
  // across the settle boundary (t4); the jump must be tiny.
  test('settle eases in — no velocity jerk at the landing (t4 boundary)', () => {
    for (const [col, count] of [
      [0, 1],
      [0, 3],
      [2, 3],
    ] as const) {
      const isLast = col === count - 1;
      const t4 =
        WINDUP_MS +
        (BLUR_MS + col * STOP_STAGGER_MS) +
        FRICTION_MS +
        (isLast ? CRAWL_MS : 0);
      const w = 2;
      const vBefore =
        (spinOffset(t4 - w, TARGET, col, count, ITEM_H) -
          spinOffset(t4, TARGET, col, count, ITEM_H)) /
        w;
      const vAfter =
        (spinOffset(t4, TARGET, col, count, ITEM_H) -
          spinOffset(t4 + w, TARGET, col, count, ITEM_H)) /
        w;
      // Both sides descending-or-still and continuous: the settle does not
      // resume at a nonzero speed the way the old half-sine did (~0.67 px/ms).
      expect(Math.abs(vAfter - vBefore)).toBeLessThan(0.15);
    }
  });
  test('non-last column skips crawl (still lands exactly on target)', () => {
    const durNonLast = columnDurationMs(0, 2);
    expect(spinOffset(durNonLast, TARGET, 0, 2, ITEM_H)).toBe(TARGET);
  });

  // Streaming-blur contract (spec decision #31): the blur phase must actually
  // travel — many cells stream past, not the wind-up's half-cell crawling back.
  test('blur phase streams at least 10 cells of travel', () => {
    for (const [col, count] of [
      [0, 1],
      [0, 3],
      [2, 3],
    ] as const) {
      const blurMs = BLUR_MS + col * STOP_STAGGER_MS;
      const atBlurStart = spinOffset(WINDUP_MS, TARGET, col, count, ITEM_H);
      const atBlurEnd = spinOffset(
        WINDUP_MS + blurMs,
        TARGET,
        col,
        count,
        ITEM_H,
      );
      expect(atBlurStart - atBlurEnd).toBeGreaterThanOrEqual(ITEM_H * 10);
    }
  });

  test('blur → friction handoff is velocity-continuous (no jerk)', () => {
    for (const [col, count] of [
      [0, 1],
      [2, 3],
    ] as const) {
      const t2 = WINDUP_MS + BLUR_MS + col * STOP_STAGGER_MS;
      const w = 10; // ms sampling window on each side
      const vBefore =
        (spinOffset(t2 - w, TARGET, col, count, ITEM_H) -
          spinOffset(t2, TARGET, col, count, ITEM_H)) /
        w;
      const vAfter =
        (spinOffset(t2, TARGET, col, count, ITEM_H) -
          spinOffset(t2 + w, TARGET, col, count, ITEM_H)) /
        w;
      expect(vBefore).toBeGreaterThan(0); // descending on both sides
      expect(vAfter).toBeGreaterThan(0);
      const ratio = vAfter / vBefore;
      expect(ratio).toBeGreaterThan(0.8);
      expect(ratio).toBeLessThan(1.25);
    }
  });

  // The whole travel (including the wind-up peak) must fit the fixed 48-cell
  // strip at the REAL vault target: winner pinned at VAULT_WIN_INDEX, window at
  // its max height (ITEM_H * VISIBLE_CELLS). No frame may paint past either end.
  test('full travel stays inside the strip at the real vault target', () => {
    const winH = REEL_ITEM_H * VISIBLE_CELLS;
    const target = reelTargetY(VAULT_WIN_INDEX, REEL_ITEM_H, winH);
    const maxOffset = STRIP_LEN * REEL_ITEM_H - winH;
    for (const [col, count] of [
      [0, 1],
      [0, 3],
      [1, 3],
      [2, 3],
    ] as const) {
      const dur = columnDurationMs(col, count);
      for (let t = 0; t <= dur; t += 8) {
        const o = spinOffset(t, target, col, count, REEL_ITEM_H);
        expect(o).toBeGreaterThanOrEqual(0);
        expect(o).toBeLessThanOrEqual(maxOffset + 0.001);
      }
    }
  });
});

describe('buildVaultStrip', () => {
  test('pins the winner at the win index', () => {
    const strip = buildVaultStrip(150, STRIP_LEN, VAULT_WIN_INDEX);
    expect(strip).toHaveLength(STRIP_LEN);
    expect(strip[VAULT_WIN_INDEX]).toBe(150);
  });
  test('decoys repeat from a small pool (slot symbol set)', () => {
    const strip = buildVaultStrip(150, STRIP_LEN, VAULT_WIN_INDEX);
    const decoys = new Set(strip.filter((_, i) => i !== VAULT_WIN_INDEX));
    expect(decoys.size).toBeLessThanOrEqual(12);
    expect(decoys.size).toBeGreaterThanOrEqual(8); // still varied, not one sprite
  });
  test('null / out-of-range winner falls back to a valid dex', () => {
    for (const bad of [null, 0, 99999]) {
      const strip = buildVaultStrip(bad, STRIP_LEN, VAULT_WIN_INDEX);
      const w = strip[VAULT_WIN_INDEX]!;
      expect(w).toBeGreaterThanOrEqual(1);
      expect(w).toBeLessThanOrEqual(1025);
    }
  });
  test('rejects invalid geometry like buildDexStrip', () => {
    expect(() => buildVaultStrip(1, 0, 0)).toThrow(RangeError);
    expect(() => buildVaultStrip(1, 10, 10)).toThrow(RangeError);
  });
});

describe('cellCurve', () => {
  test('center cell faces the viewer: no tilt/depth, full brightness, bulged', () => {
    const c = cellCurve(0, 280);
    expect(c.rotateXDeg).toBe(0);
    expect(c.brightness).toBe(1);
    expect(c.translateZPx).toBe(0);
    expect(c.translateYPx).toBe(0);
    // spec #39: the payline row bulges toward the viewer (biggest cell)
    expect(c.scale).toBeCloseTo(1.3, 2);
  });
  test('symmetric rotation, mirrored sign', () => {
    const up = cellCurve(-140, 280);
    const down = cellCurve(140, 280);
    expect(up.rotateXDeg).toBeCloseTo(-down.rotateXDeg);
    expect(up.scale).toBeCloseTo(down.scale);
    expect(up.brightness).toBeCloseTo(down.brightness);
    expect(up.translateYPx).toBeCloseTo(-down.translateYPx);
  });
  test('clamps beyond the 82° wrap cap', () => {
    // 420/280 = 1.5 rad ≈ 86° — past the cap, so identical to any farther cell.
    expect(cellCurve(9999, 280)).toEqual(cellCurve(420, 280));
  });
  // Spec decisions #36 + #37b: TRUE CYLINDER projection driven by ARC angle
  // (θ = s/R). Encoded so a tweak can't silently regress it to a linear fold:
  //  1. the middle band stays flat + bright (faces the viewer, closest);
  //  2. the rim wraps hard (near edge-on, dark, pushed away in depth);
  //  3. width never shrinks by a uniform scale — a cylinder keeps its width;
  //  4. rows BUNCH toward the rims: painted position remaps to R·sin(s/R).
  test('cylinder: middle band stays flat and bright', () => {
    const near = cellCurve(0.4 * 280, 280); // 40% out — still on the flat band
    expect(near.rotateXDeg).toBeGreaterThan(-30);
    expect(near.brightness).toBeGreaterThanOrEqual(0.85);
    expect(Math.abs(near.translateZPx)).toBeLessThan(20);
  });
  test('cylinder: rim wraps hard away from the viewer', () => {
    const edge = cellCurve(420, 280); // at/past the wrap cap
    expect(edge.rotateXDeg).toBeLessThanOrEqual(-75);
    expect(edge.brightness).toBeLessThanOrEqual(0.42);
    expect(edge.translateZPx).toBeLessThanOrEqual(-100);
  });
  test('cylinder: center bulges toward viewer, rim unscaled (spec #39)', () => {
    // NOT a uniform rim-shrink (the #35 fold): the CENTER is enlarged and the
    // rim is exactly 1.0 — closest-is-biggest, like a real drum front.
    expect(cellCurve(0, 280).scale).toBeCloseTo(1.3, 2); // dead-center = 1+bulge
    expect(cellCurve(420, 280).scale).toBeCloseTo(1, 5); // rim (past cap) = 1
    // monotonic: closer to the payline = bigger
    expect(cellCurve(60, 280).scale).toBeGreaterThan(cellCurve(180, 280).scale);
    expect(cellCurve(180, 280).scale).toBeGreaterThan(
      cellCurve(260, 280).scale,
    );
    // never smaller than 1 (a cylinder front never shrinks below its true width)
    expect(cellCurve(200, 280).scale).toBeGreaterThanOrEqual(1);
  });
  test('cylinder: rows bunch toward the rims (projected spacing)', () => {
    // A cell one radius out projects to R·sin(1 rad) ≈ 0.84·R — pulled toward
    // the center by ~44px at R=280.
    const oneRadius = cellCurve(280, 280);
    expect(oneRadius.translateYPx).toBeLessThan(-30);
    expect(oneRadius.translateYPx).toBeGreaterThan(-60);
    // Equal arc steps project to SHRINKING screen steps near the rim.
    const proj = (s: number) => s + cellCurve(s, 280).translateYPx;
    const stepNearCenter = proj(60) - proj(0);
    const stepNearRim = proj(280) - proj(220);
    expect(stepNearRim).toBeLessThan(stepNearCenter * 0.75);
  });
});

describe('blurStretch', () => {
  test('at rest: no stretch, full opacity, NO blur', () => {
    expect(blurStretch(0)).toEqual({ scaleY: 1, opacity: 1, blurPx: 0 });
  });
  test('stretch and dim are clamped at high velocity', () => {
    const fast = blurStretch(50);
    expect(fast.scaleY).toBeLessThanOrEqual(1.35);
    expect(fast.opacity).toBeGreaterThanOrEqual(0.55);
  });
  // Spec decision #38: real motion blur — velocity-scaled blurPx, 0 at rest,
  // ramps with speed, capped so a phone GPU isn't blurring a huge radius.
  test('motion blur is zero at rest and grows with speed, capped', () => {
    expect(blurStretch(0).blurPx).toBe(0);
    // peak spin velocity is ~2.8px/ms — blur should be clearly visible there
    const fast = blurStretch(2.8);
    expect(fast.blurPx).toBeGreaterThan(2);
    expect(fast.blurPx).toBeLessThanOrEqual(5);
    // monotonic: faster = more blur (until the cap)
    expect(blurStretch(1).blurPx).toBeGreaterThan(blurStretch(0.3).blurPx);
    // hard cap holds even at absurd velocity
    expect(blurStretch(999).blurPx).toBeLessThanOrEqual(5);
  });
  test('settle-speed blur is small (lands nearly sharp)', () => {
    // at the settle entry velocity (~0.68px/ms) blur should be a soft trace,
    // not a smear — the winner reads crisp as it stops.
    expect(blurStretch(0.68).blurPx).toBeLessThan(1.5);
  });
});
