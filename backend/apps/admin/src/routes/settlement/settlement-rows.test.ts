import { describe, expect, it } from 'vitest';
import type { SettlementPeriod } from '../../lib/admin-rest';
import { resultRow } from './settlement-rows';

const period = (over: Partial<SettlementPeriod> = {}): SettlementPeriod => ({
  period: '2026-09-01',
  deposits: {
    count: 7,
    gross: 350,
    net: 346.2,
    fee: 3.8,
    missingNet: 0,
    missingGross: 0,
  },
  withdrawals: {
    count: 1,
    gross: 50,
    net: 51,
    fee: 1,
    missingNet: 0,
    missingGross: 0,
  },
  ledger: { topupCredited: 26425, cashoutNet: 50 },
  delta: { deposits: -26075, withdrawals: 0 },
  ...over,
});

describe('resultRow', () => {
  it('nets money in − both fees − money out, and carries the deposit gap', () => {
    expect(resultRow(period())).toEqual({
      period: '2026-09-01',
      inGross: 350,
      inCount: 7,
      fees: 4.8,
      outGross: 50,
      outCount: 1,
      net: 295.2,
      gap: -26075,
      payoutGap: 0,
      feeFloor: false,
      grossFloor: false,
    });
  });

  it('a gap under half a sen is a match, and missing figures flag a floor', () => {
    const r = resultRow(
      period({
        delta: { deposits: 0.004, withdrawals: 12 },
        deposits: {
          count: 2,
          gross: 20,
          net: 19,
          fee: 1,
          missingNet: 1,
          missingGross: 1,
        },
      }),
    );
    expect(r.gap).toBe(0);
    // The payout delta is timing-skewed, so it is not the check, but it is
    // still shown: a payout debited and never paid surfaces here.
    expect(r.payoutGap).toBe(12);
    expect(r.feeFloor).toBe(true);
    expect(r.grossFloor).toBe(true);
  });
});
