import { describe, it, expect } from 'vitest';
import { LEVELS, foldRangesLocal, summarizeLevels } from './voucher-ranges';

// Guards the assumption baked into the fixtures below (a 100-level ladder).
it('folds over a 100-level ladder', () => {
  expect(LEVELS).toBe(100);
});

describe('foldRangesLocal — happy path', () => {
  it('folds contiguous ranges covering 1..LEVELS into a per-level amount array', () => {
    expect(
      foldRangesLocal([
        { from: 1, to: 50, amountInput: '5' },
        { from: 51, to: 100, amountInput: '10' },
      ]),
    ).toEqual({
      levels: [...Array(50).fill(5), ...Array(50).fill(10)],
    });
  });
});

describe('foldRangesLocal — out of bounds', () => {
  it('flags from < 1 as an invalid range', () => {
    const r = foldRangesLocal([{ from: 0, to: 100, amountInput: '5' }]);
    expect('errors' in r).toBe(true);
    if (!('errors' in r)) throw new Error('expected errors');
    expect(r.errors.some((e) => e.includes('is invalid'))).toBe(true);
  });

  it('flags to > LEVELS as an invalid range', () => {
    const r = foldRangesLocal([{ from: 1, to: 101, amountInput: '5' }]);
    expect('errors' in r).toBe(true);
    if (!('errors' in r)) throw new Error('expected errors');
    expect(r.errors.some((e) => e.includes('is invalid'))).toBe(true);
  });

  it('flags from > to as an invalid range', () => {
    const r = foldRangesLocal([{ from: 60, to: 40, amountInput: '5' }]);
    expect('errors' in r).toBe(true);
    if (!('errors' in r)) throw new Error('expected errors');
    expect(r.errors.some((e) => e.includes('is invalid'))).toBe(true);
  });

  it('flags a non-integer bound as an invalid range', () => {
    const r = foldRangesLocal([{ from: 1.5, to: 100, amountInput: '5' }]);
    expect('errors' in r).toBe(true);
    if (!('errors' in r)) throw new Error('expected errors');
    expect(r.errors.some((e) => e.includes('is invalid'))).toBe(true);
  });
});

describe('foldRangesLocal — overlap', () => {
  it('reports an overlap when two ranges cover the same levels', () => {
    // 1..100 fully covered (no gaps), 50..60 overlaps the first range.
    const r = foldRangesLocal([
      { from: 1, to: 100, amountInput: '5' },
      { from: 50, to: 60, amountInput: '7' },
    ]);
    expect('errors' in r).toBe(true);
    if (!('errors' in r)) throw new Error('expected errors');
    expect(r.errors.some((e) => e.includes('overlap at'))).toBe(true);
    // The overlapping levels are named exactly (50–60).
    expect(r.errors.some((e) => e.includes('50–60'))).toBe(true);
  });
});

describe('foldRangesLocal — gaps', () => {
  it('reports the uncovered level when a range leaves a gap', () => {
    // 1..50 and 52..100 leave level 51 uncovered.
    const r = foldRangesLocal([
      { from: 1, to: 50, amountInput: '5' },
      { from: 52, to: 100, amountInput: '5' },
    ]);
    expect('errors' in r).toBe(true);
    if (!('errors' in r)) throw new Error('expected errors');
    const gapErr = r.errors.find((e) => e.includes('not covered by any range'));
    expect(gapErr).toBeDefined();
    // Singular wording + the exact missing level.
    expect(gapErr).toBe('Level 51 is not covered by any range.');
  });
});

describe('foldRangesLocal — amount parsing', () => {
  it('treats a blank amount as RM 0 (Number("") === 0), not an error', () => {
    expect(foldRangesLocal([{ from: 1, to: 100, amountInput: '' }])).toEqual({
      levels: Array(100).fill(0),
    });
  });

  it('rejects a non-numeric amount', () => {
    const r = foldRangesLocal([{ from: 1, to: 100, amountInput: 'abc' }]);
    expect('errors' in r).toBe(true);
    if (!('errors' in r)) throw new Error('expected errors');
    expect(r.errors.some((e) => e.includes('needs an RM amount'))).toBe(true);
  });
});

describe('summarizeLevels', () => {
  it('collapses (unsorted) levels into compact ranges', () => {
    expect(summarizeLevels([90, 42, 43, 44])).toBe('42–44, 90');
  });

  it('renders a single level without a dash', () => {
    expect(summarizeLevels([7])).toBe('7');
  });
});
