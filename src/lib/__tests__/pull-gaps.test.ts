import { describe, it, expect } from 'vitest';
import { gapScale, gapPercent } from '../pull-gaps';

describe('gapScale — the stats chart axis', () => {
  it('lays the axis out in multiples of the expected gap, three by default', () => {
    expect(gapScale(91, 60, [27, 42, 9])).toEqual({
      max: 273,
      ticks: [0, 91, 182, 273],
      line: 91,
    });
  });

  it('stretches past three multiples only when a bar would overflow', () => {
    const s = gapScale(91, null, [300]);
    expect(s.ticks).toEqual([0, 91, 182, 273, 364]);
    expect(s.max).toBe(364);
  });

  it('lays a fractional line out in whole-draw ticks that never pass the right edge', () => {
    const s = gapScale(90.6, null, [50]);
    expect(s.ticks).toEqual([0, 91, 182, 273]);
    expect(s.max).toBe(273);
    expect(s.line).toBe(90.6);
    expect(Math.max(...s.ticks)).toBeLessThanOrEqual(s.max);
    // A sub-1 mean still gets a usable unit.
    expect(gapScale(0.4, null, [1]).ticks).toEqual([0, 1, 2, 3]);
  });

  it('falls back to the observed mean when the pack publishes no rate', () => {
    expect(gapScale(null, 40, [10, 70])).toEqual({
      max: 120,
      ticks: [0, 40, 80, 120],
      line: 40,
    });
  });

  it('with no reference at all, is a plain 0..max axis', () => {
    expect(gapScale(null, null, [27])).toEqual({
      max: 27,
      ticks: [0, 14, 27],
      line: null,
    });
    // An empty ledger still gets a usable axis.
    expect(gapScale(null, null, [])).toEqual({
      max: 1,
      ticks: [0, 1],
      line: null,
    });
  });
});

describe('gapPercent', () => {
  it('scales into the column and clamps both ends', () => {
    expect(gapPercent(91, 273)).toBeCloseTo(33.33);
    expect(gapPercent(500, 273)).toBe(100);
    expect(gapPercent(0, 273)).toBe(0);
    // A tiny gap still paints a visible sliver.
    expect(gapPercent(1, 10_000)).toBe(1);
    expect(gapPercent(5, 0)).toBe(0);
  });
});
