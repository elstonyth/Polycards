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
  pressTravelPx,
  pressSpinOffset,
  blurStretch,
  CARD_ASPECT,
} from '@/lib/vault-reel';
import {
  ITEM_H as REEL_ITEM_H,
  STRIP_LEN,
  reelTarget,
  reelTargetY,
} from '@/lib/reel';
import { HREEL_VISIBLE_CELLS } from '@/lib/hreel';

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

  // Spec decision #33 (a) + audio-sync retune: lengthened so the reel's cell
  // crossings form a full accelerate→decelerate tick arc (the spin's sole audio)
  // landing on the winner. A range, not exact constants, so retunes don't churn.
  test('a single-reel spin runs ~4.9s (long readable decelerating tick arc)', () => {
    expect(columnDurationMs(0, 1)).toBeGreaterThan(4200);
    expect(columnDurationMs(0, 1)).toBeLessThan(5400);
  });
  test('a 3-reel spin lands ~5.7s (ticks decelerate onto the winner lock)', () => {
    expect(spinTotalMs(3)).toBeGreaterThan(5000);
    expect(spinTotalMs(3)).toBeLessThan(6200);
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

describe('pressTravelPx / pressSpinOffset (press-launched spin)', () => {
  const PITCH = 79;
  // A plausible idle position (mid-drift) and the target one ideal-travel ahead.
  const START = 500;
  const targetFor = (col: number, count: number) =>
    START + Math.round(pressTravelPx(col, count, PITCH));

  test('travel is long enough for the full landing (friction + crawl + windup)', () => {
    for (let col = 0; col < 3; col++) {
      expect(pressTravelPx(col, 3, PITCH)).toBeGreaterThan(PITCH * 9);
    }
  });

  test('stagger: later columns travel farther (they stop later at equal feel)', () => {
    expect(pressTravelPx(1, 3, PITCH)).toBeGreaterThan(
      pressTravelPx(0, 3, PITCH),
    );
    expect(pressTravelPx(2, 3, PITCH)).toBeGreaterThan(
      pressTravelPx(1, 3, PITCH),
    );
  });

  test('starts EXACTLY at the current position and ends exactly at target', () => {
    const target = targetFor(0, 1);
    expect(pressSpinOffset(0, START, target, 0, 1, PITCH)).toBe(START);
    const dur = columnDurationMs(0, 1);
    expect(pressSpinOffset(dur, START, target, 0, 1, PITCH)).toBe(target);
    expect(pressSpinOffset(dur + 5000, START, target, 0, 1, PITCH)).toBe(
      target,
    );
  });

  test('duration parity: the trajectory rests at target from columnDurationMs on', () => {
    for (const [col, count] of [
      [0, 3],
      [2, 3],
      [0, 1],
    ] as const) {
      const target = targetFor(col, count);
      const dur = columnDurationMs(col, count);
      expect(pressSpinOffset(dur, START, target, col, count, PITCH)).toBe(
        target,
      );
      // ...and is NOT yet at rest just before the settle completes.
      expect(
        pressSpinOffset(dur - SETTLE_MS / 2, START, target, col, count, PITCH),
      ).not.toBe(target);
    }
  });

  test('wind-up pulls BACK below the start, never more than half a cell', () => {
    const target = targetFor(0, 1);
    let minPx = Infinity;
    for (let t = 0; t <= WINDUP_MS; t += 10) {
      minPx = Math.min(minPx, pressSpinOffset(t, START, target, 0, 1, PITCH));
    }
    expect(minPx).toBeLessThan(START);
    expect(minPx).toBeGreaterThanOrEqual(START - PITCH / 2);
  });

  test('no teleport: the position is CONTINUOUS (bounded per-ms step) end to end', () => {
    for (const [col, count] of [
      [0, 3],
      [2, 3],
    ] as const) {
      const target = targetFor(col, count);
      const dur = columnDurationMs(col, count);
      let prev = pressSpinOffset(0, START, target, col, count, PITCH);
      let maxStep = 0;
      for (let t = 1; t <= dur + 50; t += 1) {
        const px = pressSpinOffset(t, START, target, col, count, PITCH);
        maxStep = Math.max(maxStep, Math.abs(px - prev));
        prev = px;
      }
      // Peak speed is the accel→friction handoff ≈ 3·frictionPx/FRICTION_MS
      // (a few px/ms). Anything double-digit would be a visible jump.
      expect(maxStep).toBeLessThan(6);
    }
  });

  test('forward-only after the wind-up until the settle (monotonic travel)', () => {
    const target = targetFor(2, 3);
    const dur = columnDurationMs(2, 3);
    let prev = -Infinity;
    for (let t = WINDUP_MS; t <= dur - SETTLE_MS; t += 5) {
      const px = pressSpinOffset(t, START, target, 2, 3, PITCH);
      expect(px).toBeGreaterThanOrEqual(prev);
      prev = px;
    }
  });

  test('settle overshoots PAST the target by less than 0.4 cells, then returns', () => {
    const target = targetFor(0, 1);
    const dur = columnDurationMs(0, 1);
    let maxPx = -Infinity;
    for (let t = dur - SETTLE_MS; t <= dur; t += 5) {
      maxPx = Math.max(maxPx, pressSpinOffset(t, START, target, 0, 1, PITCH));
    }
    expect(maxPx).toBeGreaterThan(target);
    expect(maxPx).toBeLessThan(target + PITCH * 0.4);
  });

  test('velocity-continuous accel→friction handoff (no jerk at the blur exit)', () => {
    const target = targetFor(0, 1);
    const tHandoff = WINDUP_MS + BLUR_MS; // accelMs(0) = BLUR_MS
    const d = 4;
    const vBefore =
      (pressSpinOffset(tHandoff - 1, START, target, 0, 1, PITCH) -
        pressSpinOffset(tHandoff - 1 - d, START, target, 0, 1, PITCH)) /
      d;
    const vAfter =
      (pressSpinOffset(tHandoff + 1 + d, START, target, 0, 1, PITCH) -
        pressSpinOffset(tHandoff + 1, START, target, 0, 1, PITCH)) /
      d;
    expect(Math.abs(vAfter - vBefore)).toBeLessThan(vBefore * 0.1);
  });
});

describe('press-spin paint bounds (regression: never paints past either strip end)', () => {
  // Mirrors ReelStrip's exact arithmetic (cellSize -> pitch/winW, CELL_GAP=10,
  // IDLE_BASE_INDEX=5, the winner-index inversion of reelTarget) and
  // buildPressStrip's length formula (winIdx + ceil(visible/2) + 2). The old
  // reel.test.ts "strip bounds" test guarded this invariant for the retired
  // spinOffset/reelPaintX path; this is its press-spin successor. The margins
  // are tight and load-bearing: settle overshoot (0.32 cells) vs the 2-cell
  // tail margin on the right, windup (0.5 cells) vs IDLE_BASE_INDEX on the left.
  const CELL_GAP = 10;
  const IDLE_BASE_INDEX = 5;

  test('window stays on the strip for every frame, start position, pool and column', () => {
    for (const cellSize of [76, 96]) {
      const pitch = Math.round(cellSize * CARD_ASPECT) + CELL_GAP;
      const winW = pitch * HREEL_VISIBLE_CELLS;
      const basePx = Math.round(
        reelTarget(IDLE_BASE_INDEX, pitch, winW) - CELL_GAP / 2,
      );
      for (const poolLen of [1, 12, 50]) {
        for (const [col, count] of [
          [0, 1],
          [0, 3],
          [2, 3],
        ] as const) {
          // Sample the whole idle band, including just below the wrap boundary.
          for (const frac of [0, 0.37, 0.99]) {
            const startPx = basePx + frac * poolLen * pitch;
            const travel = pressTravelPx(col, count, pitch);
            const idx = Math.round(
              (startPx + travel + winW / 2 + CELL_GAP / 2 - pitch / 2) / pitch,
            );
            const target = Math.round(
              reelTarget(idx, pitch, winW) - CELL_GAP / 2,
            );
            const stripPx =
              (idx + Math.ceil(HREEL_VISIBLE_CELLS / 2) + 2) * pitch;
            const dur = columnDurationMs(col, count);
            for (let t = 0; t <= dur + 32; t += 16) {
              const px = pressSpinOffset(t, startPx, target, col, count, pitch);
              expect(px).toBeGreaterThanOrEqual(0);
              expect(px + winW).toBeLessThanOrEqual(stripPx);
            }
          }
        }
      }
    }
  });
});
