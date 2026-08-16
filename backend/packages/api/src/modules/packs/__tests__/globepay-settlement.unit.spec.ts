import {
  mergeSettlementPeriods,
  settlementSince,
  type GatewayPeriodRow,
  type LedgerPeriodRow,
} from '../globepay-settlement';

const gw = (over: Partial<GatewayPeriodRow>): GatewayPeriodRow => ({
  period: '2026-08-01',
  count: 0,
  grossCents: 0,
  netCents: 0,
  grossWithNetCents: 0,
  missingNet: 0,
  ...over,
});

const lg = (over: Partial<LedgerPeriodRow>): LedgerPeriodRow => ({
  period: '2026-08-01',
  topupCents: 0,
  cashoutCents: 0,
  ...over,
});

describe('mergeSettlementPeriods', () => {
  it('computes gross / net / fee in whole cents, converted once', () => {
    const [p] = mergeSettlementPeriods(
      [
        gw({
          count: 3,
          grossCents: 15_000, // RM 150.00
          netCents: 14_550, // RM 145.50
          grossWithNetCents: 15_000,
          missingNet: 0,
        }),
      ],
      [],
      [lg({ topupCents: 15_000 })],
    );
    expect(p.deposits).toEqual({
      count: 3,
      gross: 150,
      net: 145.5,
      fee: 4.5,
      missingNet: 0,
    });
    expect(p.delta.deposits).toBe(0);
  });

  it('fee is computed over the known-net subset ONLY — NULL nets never deflate it', () => {
    // Two settled rows: RM 100 with net 97, RM 50 settled pre-mirror (no net).
    const [p] = mergeSettlementPeriods(
      [
        gw({
          count: 2,
          grossCents: 15_000,
          netCents: 9_700,
          grossWithNetCents: 10_000, // only the known-net row's gross
          missingNet: 1,
        }),
      ],
      [],
      [],
    );
    // Fee = 100 − 97 over the known row, NOT 150 − 97 = 53.
    expect(p.deposits.fee).toBe(3);
    expect(p.deposits.missingNet).toBe(1);
  });

  it('surfaces the gateway-vs-ledger delta per period, in exact cents', () => {
    const [p] = mergeSettlementPeriods(
      [gw({ grossCents: 10_000 })],
      [gw({ grossCents: 5_000 })],
      [lg({ topupCents: 9_000, cashoutCents: 5_000 })],
    );
    // RM 100 settled at the gateway, RM 90 credited in the ledger: RM 10 gap —
    // exactly the "settled deposit whose credit never landed" signal (B5).
    expect(p.delta.deposits).toBe(10);
    expect(p.delta.withdrawals).toBe(0);
  });

  it('a period present in only one source still appears, with zeroed halves', () => {
    const report = mergeSettlementPeriods(
      [gw({ period: '2026-08-01', grossCents: 1_000 })],
      [gw({ period: '2026-07-01', grossCents: 2_000 })],
      [lg({ period: '2026-06-01', topupCents: 500 })],
    );
    expect(report.map((p) => p.period)).toEqual([
      '2026-08-01',
      '2026-07-01',
      '2026-06-01',
    ]); // newest first
    expect(report[0].withdrawals.gross).toBe(0);
    expect(report[1].deposits.gross).toBe(0);
    // Ledger-only period: a top-up with NO gateway row behind it shows as a
    // negative deposits delta — the mock/manual-topup signal (audit C1).
    expect(report[2].delta.deposits).toBe(-5);
  });

  it('float-hostile cents still land exact (the 49.999999… class)', () => {
    const [p] = mergeSettlementPeriods(
      [
        gw({
          grossCents: 6_407,
          netCents: 1_407,
          grossWithNetCents: 6_407,
        }),
      ],
      [],
      [lg({ topupCents: 1_407 })],
    );
    expect(p.deposits.fee).toBe(50); // 6407−1407 = 5000 cents exactly
    expect(p.delta.deposits).toBe(50);
  });
});

describe('settlementSince', () => {
  // 2026-08-17T02:00Z = 10:00 MYT, a Monday.
  const now = new Date('2026-08-17T02:00:00Z');

  it('month: first day of the MYT month periodsBack−1 months ago, as a UTC instant', () => {
    // 1 period = this month: 2026-08-01 00:00 MYT = 2026-07-31T16:00Z.
    expect(settlementSince('month', 1, now).toISOString()).toBe(
      '2026-07-31T16:00:00.000Z',
    );
    expect(settlementSince('month', 3, now).toISOString()).toBe(
      '2026-05-31T16:00:00.000Z',
    );
  });

  it('week: ISO Monday of the MYT week, matching date_trunc(week)', () => {
    // now IS a MYT Monday: 1 period starts that same MYT midnight.
    expect(settlementSince('week', 1, now).toISOString()).toBe(
      '2026-08-16T16:00:00.000Z',
    );
    expect(settlementSince('week', 2, now).toISOString()).toBe(
      '2026-08-09T16:00:00.000Z',
    );
  });

  it('week: a MYT Sunday still belongs to the week begun the previous Monday', () => {
    // 2026-08-16 was a Sunday. 23:00 MYT Sunday = 15:00Z.
    const sunday = new Date('2026-08-16T15:00:00Z');
    expect(settlementSince('week', 1, sunday).toISOString()).toBe(
      '2026-08-09T16:00:00.000Z',
    );
  });

  it('MYT day differing from the UTC day picks the MYT month', () => {
    // 2026-08-31T18:00Z is already 2026-09-01 02:00 MYT.
    const rollover = new Date('2026-08-31T18:00:00Z');
    expect(settlementSince('month', 1, rollover).toISOString()).toBe(
      '2026-08-31T16:00:00.000Z', // 2026-09-01 00:00 MYT
    );
  });
});
