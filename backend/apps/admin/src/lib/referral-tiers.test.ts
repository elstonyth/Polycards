import { describe, expect, it } from 'vitest';
import {
  tierRowsToPayload,
  validateTierRows,
  type TierRow,
} from './referral-tiers';

const rows = (...r: [string, string][]): TierRow[] =>
  r.map(([minRm, ratePct]) => ({ minRm, ratePct }));

describe('validateTierRows', () => {
  it('accepts the default ladder', () => {
    expect(
      validateTierRows(
        rows(['0', '0.5'], ['6000', '1'], ['15000', '1.5'], ['30000', '2']),
      ),
    ).toBeNull();
  });

  it('requires the first row to start at 0', () => {
    expect(validateTierRows(rows(['100', '1']))).toMatch(/first tier/i);
  });

  it('requires strictly increasing bounds', () => {
    expect(validateTierRows(rows(['0', '1'], ['0', '2']))).toMatch(
      /increasing/i,
    );
    expect(
      validateTierRows(rows(['0', '1'], ['5000', '2'], ['4000', '3'])),
    ).toMatch(/increasing/i);
  });

  it('rejects non-numeric and out-of-range values', () => {
    expect(validateTierRows(rows(['x', '1']))).toMatch(/number/i);
    expect(validateTierRows(rows(['0', '101']))).toMatch(/rate/i);
    expect(validateTierRows(rows(['0', '-1']))).toMatch(/rate/i);
    expect(validateTierRows([])).toMatch(/at least one/i);
  });

  it('rejects a rate with more than 2 decimal places (sub-bp)', () => {
    expect(validateTierRows(rows(['0', '0.505']))).toMatch(/rate/i);
  });
});

describe('tierRowsToPayload', () => {
  it('converts RM to cents and % to basis points', () => {
    expect(tierRowsToPayload(rows(['0', '0.5'], ['6000', '1']))).toEqual([
      { min_cents: 0, rate_bp: 50 },
      { min_cents: 600_000, rate_bp: 100 },
    ]);
  });
});
