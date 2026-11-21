import { describe, expect, it } from 'vitest';
import {
  LOGO_LETTERS,
  LOGO_MARK,
} from '@/components/brand/polycards-logo-paths';
import {
  DEFAULT_TIMINGS,
  LETTERS_START_MS,
  REVEAL_MS,
  cubicBezier,
  leaveAtMs,
  letterOffset,
  loaderPhase,
  pathYExtent,
  springPosition,
  splitSubpaths,
  strokeProgress,
} from '../loader-timeline';

describe('loaderPhase', () => {
  it('reveals, then holds until ready', () => {
    expect(loaderPhase(0, null)).toBe('revealing');
    expect(loaderPhase(REVEAL_MS - 1, null)).toBe('revealing');
    expect(loaderPhase(REVEAL_MS, null)).toBe('holding');
    expect(loaderPhase(5000, null)).toBe('holding');
  });

  it('never leaves before the minimum, even when ready at once', () => {
    expect(loaderPhase(100, 0)).toBe('revealing');
    expect(loaderPhase(DEFAULT_TIMINGS.minMs - 1, 0)).toBe('revealing');
    expect(loaderPhase(DEFAULT_TIMINGS.minMs, 0)).toBe('exiting');
    expect(loaderPhase(DEFAULT_TIMINGS.minMs + DEFAULT_TIMINGS.exitMs, 0)).toBe(
      'done',
    );
  });

  it('leaves when ready comes after the minimum', () => {
    expect(loaderPhase(2999, 3000)).toBe('holding');
    expect(loaderPhase(3000, 3000)).toBe('exiting');
    expect(loaderPhase(3400, 3000)).toBe('done');
  });

  it('leaves at the maximum wait when ready never comes', () => {
    expect(leaveAtMs(null, DEFAULT_TIMINGS)).toBe(6000);
    expect(loaderPhase(5999, null)).toBe('holding');
    expect(loaderPhase(6000, null)).toBe('exiting');
    expect(loaderPhase(6400, null)).toBe('done');
    // A ready that arrives later than the cap does not extend it.
    expect(leaveAtMs(9000, DEFAULT_TIMINGS)).toBe(6000);
  });

  it('honours custom timings', () => {
    const timings = { minMs: 500, maxMs: 1000, exitMs: 200 };
    expect(leaveAtMs(0, timings)).toBe(500);
    expect(loaderPhase(1100, null, timings)).toBe('exiting');
    expect(loaderPhase(1200, null, timings)).toBe('done');
  });
});

describe('reveal curves', () => {
  it('matches the CSS cubic-bezier end points and symmetry', () => {
    const ease = cubicBezier(0.65, 0, 0.35, 1);
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5, 6);
    expect(ease(0.25) + ease(0.75)).toBeCloseTo(1, 6);
    expect(ease(0.1)).toBeLessThan(0.05);
  });

  it('draws strokes in order and finishes them', () => {
    expect(strokeProgress(0, 0)).toBe(0);
    expect(strokeProgress(1, 50)).toBe(0);
    expect(strokeProgress(0, 350)).toBeCloseTo(0.5, 6);
    for (let i = 0; i < 6; i++) expect(strokeProgress(i, REVEAL_MS)).toBe(1);
  });

  it('springs with a hint of overshoot, not a bounce', () => {
    expect(springPosition(0)).toBe(0);
    let peak = 0;
    for (let s = 0; s < 1; s += 0.001) peak = Math.max(peak, springPosition(s));
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(1.05);
    expect(Math.abs(1 - springPosition(0.6))).toBeLessThan(0.002);
  });

  it('keeps letters fully below the cut until their turn, then exactly in place', () => {
    expect(letterOffset(0, LETTERS_START_MS)).toBe(1);
    expect(letterOffset(8, LETTERS_START_MS + 300)).toBe(1);
    for (let i = 0; i < 9; i++) expect(letterOffset(i, REVEAL_MS)).toBe(0);
    // Already settled to well under a hundredth of the travel just before the end.
    for (let i = 0; i < 9; i++)
      expect(Math.abs(letterOffset(i, REVEAL_MS - 1))).toBeLessThan(0.01);
  });
});

describe('logo geometry helpers', () => {
  it('splits the mark into subpaths that rejoin to the original', () => {
    const parts = splitSubpaths(LOGO_MARK);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.startsWith('M'))).toBe(true);
    expect(parts.join('')).toBe(LOGO_MARK.replace(/\s+(?=M)/g, ''));
  });

  it('reads letter heights through H and V commands', () => {
    expect(pathYExtent('M0 10H50V40L5 3Z')).toEqual({ minY: 3, maxY: 40 });
    expect(pathYExtent('m0 10l0 5v-20z')).toEqual({ minY: -5, maxY: 15 });
    const y = LOGO_LETTERS.find((l) => l.char === 'y');
    const l = LOGO_LETTERS.find((l) => l.char === 'l');
    // The y has the only descender; the l is a full-height stem.
    const all = LOGO_LETTERS.map((letter) => pathYExtent(letter.d).maxY);
    expect(pathYExtent(y!.d).maxY).toBe(Math.max(...all));
    expect(pathYExtent(l!.d).minY).toBeLessThan(pathYExtent(y!.d).minY);
  });
});
