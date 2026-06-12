// Economy dashboard math — pure functions so the /admin/economy route stays a
// thin aggregator and the numbers are unit-testable without a container.
// Integer-cent sums throughout, like credit-balance.ts, so float drift can't
// skew the operator's money reports.

export type OddsValue = {
  /** Relative win weight (normalized to 10000 bps on save, but the math
   *  normalizes by the actual sum so stale rows still report correctly). */
  weight: number;
  /** Card FMV in USD decimals. */
  market_value: number;
};

export type PackRtp = {
  /** Odds-weighted expected FMV per open, USD (2dp). */
  ev: number;
  /** Return-to-player: ev / price × 100 (2dp). > 100 = operator loses money. */
  rtp_pct: number;
};

/**
 * Theoretical RTP of one pack from its CURRENT odds and card FMVs. Null when
 * the question is unanswerable: empty pool, zero/invalid price, or zero total
 * weight (nothing can be rolled).
 */
export function packTheoreticalRtp(
  odds: OddsValue[],
  price: number,
): PackRtp | null {
  if (odds.length === 0) return null;
  if (!Number.isFinite(price) || price <= 0) return null;

  const totalWeight = odds.reduce(
    (sum, o) => sum + (Number.isFinite(o.weight) ? o.weight : 0),
    0,
  );
  if (totalWeight <= 0) return null;

  // Σ(weight_i / total × FMV_i), in cents. Non-finite FMVs contribute nothing
  // rather than poisoning the whole report.
  const evCents = odds.reduce((sum, o) => {
    if (!Number.isFinite(o.weight) || !Number.isFinite(o.market_value)) {
      return sum;
    }
    return sum + (o.weight / totalWeight) * Math.round(o.market_value * 100);
  }, 0);

  const ev = Math.round(evCents) / 100;
  // RTP from the UNROUNDED EV so the displayed % doesn't inherit the cent
  // rounding (1.6667/10 must report 16.67, not 16.7).
  const rtp_pct = Math.round((evCents / 100 / price) * 100 * 100) / 100;
  return { ev, rtp_pct };
}

export type LedgerRow = {
  reason: string;
  amount: number;
};

export type LedgerTotals = {
  /** |Σ pack_open| — credits spent on opens (the operator's gross take). */
  revenue: number;
  /** Σ buyback — credits paid back out for cards. */
  payouts: number;
  /** Σ topup — credits purchased (cash in, once payments are real). */
  topups: number;
  /** Σ adjustment — net operator grants/clawbacks. */
  adjustments: number;
  /** revenue − payouts — the gacha margin before fulfillment costs. */
  net: number;
};

/** Lifetime ledger totals bucketed by reason (exact cent math). */
export function ledgerTotals(rows: LedgerRow[]): LedgerTotals {
  let openCents = 0;
  let buybackCents = 0;
  let topupCents = 0;
  let adjustmentCents = 0;

  for (const row of rows) {
    if (!Number.isFinite(row.amount)) continue;
    const cents = Math.round(row.amount * 100);
    if (row.reason === "pack_open") openCents += cents;
    else if (row.reason === "buyback") buybackCents += cents;
    else if (row.reason === "topup") topupCents += cents;
    else if (row.reason === "adjustment") adjustmentCents += cents;
  }

  const revenue = Math.abs(openCents) / 100;
  const payouts = buybackCents / 100;
  return {
    revenue,
    payouts,
    topups: topupCents / 100,
    adjustments: adjustmentCents / 100,
    net: Math.round(Math.abs(openCents) - buybackCents) / 100,
  };
}
