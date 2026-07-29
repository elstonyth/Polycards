import { describe, it, expect } from 'vitest';
import { poolValueRange } from '../packs-format';

describe('poolValueRange', () => {
  it('returns the min and max of priced cards, formatted', () => {
    const pool = [
      { value: 'RM 9,869.90' },
      { value: 'RM 4,861.30' },
      { value: 'RM 45.20' },
    ];
    expect(poolValueRange(pool)).toEqual({
      min: 'RM 45.20',
      max: 'RM 9,869.90',
    });
  });

  it("ignores unpriced '—' cards", () => {
    const pool = [{ value: '—' }, { value: 'RM 100.00' }, { value: '—' }];
    expect(poolValueRange(pool)).toEqual({
      min: 'RM 100.00',
      max: 'RM 100.00',
    });
  });

  it("returns null when nothing is priced (all '—' or empty)", () => {
    expect(poolValueRange([{ value: '—' }])).toBeNull();
    expect(poolValueRange([])).toBeNull();
  });

  // Documented conflation: '—' parses to 0, so a genuine RM 0.00 is
  // indistinguishable from unpriced and is dropped the same way.
  it('drops zero-priced cards', () => {
    expect(poolValueRange([{ value: 'RM 0.00' }])).toBeNull();
    expect(
      poolValueRange([{ value: 'RM 0.00' }, { value: 'RM 12.50' }]),
    ).toEqual({ min: 'RM 12.50', max: 'RM 12.50' });
  });

  it('collapses a single priced card to min === max', () => {
    expect(poolValueRange([{ value: 'RM 1,200.00' }])).toEqual({
      min: 'RM 1,200.00',
      max: 'RM 1,200.00',
    });
  });
});
