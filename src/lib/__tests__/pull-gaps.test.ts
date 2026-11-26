import { describe, it, expect } from 'vitest';
import { axisLabels, gapScale, gapPercent } from '../pull-gaps';

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

  it('falls back to the observed mean when the pack has no Pull Odds rate', () => {
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

describe('axisLabels: the numbers the axis prints', () => {
  const ticks = (steps: number) =>
    Array.from({ length: steps + 1 }, (_, i) => i * 607);

  it('prints every tick while they stand clear of each other', () => {
    expect(axisLabels(ticks(3))).toEqual(ticks(3));
    expect(axisLabels([0, 5, 9])).toEqual([0, 5, 9]);
  });

  it('drops a tick that stands beside the last, whose number is set inside the edge', () => {
    expect(axisLabels(ticks(4))).toEqual([0, 607, 1214, 2428]);
    // the owner's screenshot (2026-11-26): "2428 3035" ran together
    expect(axisLabels(ticks(5))).toEqual([0, 607, 1821, 3035]);
  });

  it('thins a long axis, and keeps the reference and the last', () => {
    expect(axisLabels(ticks(8))).toEqual([607, 1821, 3035, 4856]);
    const long = axisLabels(ticks(12));
    expect(long).toContain(607);
    expect(long).toContain(12 * 607);
    expect(long.length).toBeLessThanOrEqual(5);
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
