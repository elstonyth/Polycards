import { ledgerTotals, packTheoreticalRtp } from "../economy";

// Economy dashboard math: theoretical RTP per pack (odds-weighted FMV vs
// price) and lifetime ledger totals bucketed by reason. Pure functions —
// integer-cent sums like credit-balance.ts so float drift can't skew reports.

describe("packTheoreticalRtp", () => {
  it("computes EV and RTP from basis-point weights x FMV", () => {
    // 50% of $10 + 50% of $30 = $20 EV on a $25 pack = 80% RTP.
    const odds = [
      { weight: 5000, market_value: 10 },
      { weight: 5000, market_value: 30 },
    ];
    expect(packTheoreticalRtp(odds, 25)).toEqual({ ev: 20, rtp_pct: 80 });
  });

  it("flags a money-losing pack with RTP above 100%", () => {
    const odds = [{ weight: 10000, market_value: 50 }];
    expect(packTheoreticalRtp(odds, 25)).toEqual({ ev: 50, rtp_pct: 200 });
  });

  it("normalizes by the actual weight sum, not the nominal 10000", () => {
    // Same 50/50 split expressed with unnormalized weights.
    const odds = [
      { weight: 1, market_value: 10 },
      { weight: 1, market_value: 30 },
    ];
    expect(packTheoreticalRtp(odds, 25)).toEqual({ ev: 20, rtp_pct: 80 });
  });

  it("returns null for an empty pool, zero price, or zero total weight", () => {
    expect(packTheoreticalRtp([], 25)).toBeNull();
    expect(
      packTheoreticalRtp([{ weight: 10000, market_value: 10 }], 0),
    ).toBeNull();
    expect(
      packTheoreticalRtp([{ weight: 0, market_value: 10 }], 25),
    ).toBeNull();
  });

  it("ignores non-finite market values rather than poisoning the sum", () => {
    const odds = [
      { weight: 5000, market_value: NaN },
      { weight: 5000, market_value: 30 },
    ];
    expect(packTheoreticalRtp(odds, 25)).toEqual({ ev: 15, rtp_pct: 60 });
  });

  it("rounds EV and RTP to cents / 2dp", () => {
    const odds = [
      { weight: 3333, market_value: 1 },
      { weight: 6667, market_value: 2 },
    ];
    const result = packTheoreticalRtp(odds, 10);
    expect(result).toEqual({ ev: 1.67, rtp_pct: 16.67 });
  });
});

describe("ledgerTotals", () => {
  it("buckets signed amounts by reason with exact cent math", () => {
    const rows = [
      { reason: "pack_open", amount: -25 },
      { reason: "pack_open", amount: -0.1 },
      { reason: "pack_open", amount: -0.2 },
      { reason: "buyback", amount: 11.61 },
      { reason: "topup", amount: 100 },
      { reason: "adjustment", amount: 5 },
      { reason: "adjustment", amount: -2.5 },
    ];
    expect(ledgerTotals(rows)).toEqual({
      revenue: 25.3, // |Σ pack_open|
      payouts: 11.61,
      topups: 100,
      adjustments: 2.5,
      net: 13.69, // revenue - payouts
    });
  });

  it("returns zeros for an empty ledger", () => {
    expect(ledgerTotals([])).toEqual({
      revenue: 0,
      payouts: 0,
      topups: 0,
      adjustments: 0,
      net: 0,
    });
  });

  it("skips unknown reasons and non-finite amounts", () => {
    const rows = [
      { reason: "mystery", amount: 999 },
      { reason: "topup", amount: NaN },
      { reason: "topup", amount: 10 },
    ];
    expect(ledgerTotals(rows).topups).toBe(10);
  });
});
