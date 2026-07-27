import { ledgerTotals, packTheoreticalRtp, publishedEv } from '../economy';

// Economy dashboard math: theoretical RTP per pack (odds-weighted FMV vs
// price) and lifetime ledger totals bucketed by reason. Pure functions —
// integer-cent sums like service.ts creditBalance so float drift can't skew reports.

describe('packTheoreticalRtp', () => {
  it('computes EV and RTP from basis-point weights x FMV', () => {
    // 50% of $10 + 50% of $30 = $20 EV on a $25 pack = 80% RTP.
    const odds = [
      { weight: 5000, market_value: 10 },
      { weight: 5000, market_value: 30 },
    ];
    expect(packTheoreticalRtp(odds, 25)).toEqual({ ev: 20, rtp_pct: 80 });
  });

  it('flags a money-losing pack with RTP above 100%', () => {
    const odds = [{ weight: 10000, market_value: 50 }];
    expect(packTheoreticalRtp(odds, 25)).toEqual({ ev: 50, rtp_pct: 200 });
  });

  it('normalizes by the actual weight sum, not the nominal 10000', () => {
    // Same 50/50 split expressed with unnormalized weights.
    const odds = [
      { weight: 1, market_value: 10 },
      { weight: 1, market_value: 30 },
    ];
    expect(packTheoreticalRtp(odds, 25)).toEqual({ ev: 20, rtp_pct: 80 });
  });

  it('returns null for an empty pool, zero price, or zero total weight', () => {
    expect(packTheoreticalRtp([], 25)).toBeNull();
    expect(
      packTheoreticalRtp([{ weight: 10000, market_value: 10 }], 0),
    ).toBeNull();
    expect(
      packTheoreticalRtp([{ weight: 0, market_value: 10 }], 25),
    ).toBeNull();
  });

  it('ignores non-finite market values rather than poisoning the sum', () => {
    const odds = [
      { weight: 5000, market_value: NaN },
      { weight: 5000, market_value: 30 },
    ];
    expect(packTheoreticalRtp(odds, 25)).toEqual({ ev: 15, rtp_pct: 60 });
  });

  // POLYCARD-BACK §2 acceptance — docx arithmetic corrected: formula wins.
  it('EV worked example: 300×0.2 + 200×0.3 + 100×0.5 = RM170, RTP 56.67%', () => {
    const odds = [
      { weight: 2000, market_value: 300 },
      { weight: 3000, market_value: 200 },
      { weight: 5000, market_value: 100 },
    ];
    expect(packTheoreticalRtp(odds, 300)).toEqual({ ev: 170, rtp_pct: 56.67 });
  });

  it('rounds EV and RTP to cents / 2dp', () => {
    const odds = [
      { weight: 3333, market_value: 1 },
      { weight: 6667, market_value: 2 },
    ];
    const result = packTheoreticalRtp(odds, 10);
    expect(result).toEqual({ ev: 1.67, rtp_pct: 16.67 });
  });
});

describe('publishedEv', () => {
  it('PubEV worked example: (100+200)/2×20% + (50+60)/2×80% = RM74', () => {
    expect(publishedEv({ Legendary: 150, Common: 55 }, { Legendary: 20, Common: 80 })).toBe(74);
  });

  it('publishedEv: null/empty published tiers → null; unknown tier keys skipped', () => {
    expect(publishedEv({ Common: 50 }, null)).toBeNull();
    expect(publishedEv({ Common: 50 }, {})).toBeNull();
    expect(publishedEv({ Common: 50 }, { Immortal: 100 })).toBeNull();
  });

  // The tier keys a pack publishes and the tiers its pool actually holds drift
  // apart (an operator publishes a Legendary % before adding one). A published
  // tier with no cards contributes nothing rather than voiding the whole EV.
  it('skips a published tier the pool has no cards for, keeping the rest', () => {
    expect(publishedEv({ Common: 50 }, { Legendary: 20, Common: 80 })).toBe(40);
  });
});

describe('ledgerTotals', () => {
  it('buckets signed amounts by reason with exact cent math', () => {
    const rows = [
      { reason: 'pack_open', amount: -25 },
      { reason: 'pack_open', amount: -0.1 },
      { reason: 'pack_open', amount: -0.2 },
      { reason: 'buyback', amount: 11.61 },
      { reason: 'topup', amount: 100 },
      { reason: 'adjustment', amount: 5 },
      { reason: 'adjustment', amount: -2.5 },
    ];
    expect(ledgerTotals(rows)).toEqual({
      revenue: 25.3, // |Σ pack_open|
      payouts: 11.61,
      topups: 100,
      adjustments: 2.5,
      net: 13.69, // revenue - payouts (no commission rows, so unchanged)
      directReferral: 0,
      teamOverride: 0,
      commissionReversal: 0,
      cashout: 0,
      rewardPromo: 0,
    });
  });

  it('returns zeros for an empty ledger', () => {
    expect(ledgerTotals([])).toEqual({
      revenue: 0,
      payouts: 0,
      topups: 0,
      adjustments: 0,
      net: 0,
      directReferral: 0,
      teamOverride: 0,
      commissionReversal: 0,
      cashout: 0,
      rewardPromo: 0,
    });
  });

  it("throws on an unknown ledger reason (no silent drop)", () => {
    expect(() =>
      ledgerTotals([{ reason: "mystery", amount: 999 }]),
    ).toThrow(/unknown ledger reason/i);
  });

  it("skips a non-finite amount rather than bucketing or throwing it", () => {
    // Guards the `Number.isFinite(row.amount)` continue in ledgerTotals: a NaN
    // amount must not poison a bucket or the net (a known reason with NaN is
    // skipped, not thrown).
    const t = ledgerTotals([{ reason: "topup", amount: NaN }]);
    expect(t.topups).toBe(0);
    expect(t.net).toBe(0);
  });

  it("buckets commission reasons and subtracts them from net", () => {
    const t = ledgerTotals([
      { reason: "pack_open", amount: -100 }, // RM100 revenue
      { reason: "buyback", amount: 20 }, // RM20 payout
      { reason: "direct_referral", amount: 5 }, // RM5 commission out
      { reason: "team_override", amount: 1 }, // RM1 commission out
      { reason: "commission_reversal", amount: -2 }, // RM2 clawed back (net + )
      { reason: "cashout", amount: -10 }, // RM10 withdrawn
    ]);
    expect(t.revenue).toBe(100);
    expect(t.payouts).toBe(20);
    expect(t.directReferral).toBe(5);
    expect(t.teamOverride).toBe(1);
    expect(t.commissionReversal).toBe(-2);
    expect(t.cashout).toBe(-10);
    // net = revenue - payouts - directReferral - teamOverride - commissionReversal
    //     = 100 - 20 - 5 - 1 - (-2) = 76. Cashout is a balance move, not P&L.
    expect(t.net).toBe(76);
  });
});
