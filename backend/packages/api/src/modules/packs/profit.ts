// The Profit report's pure folds (GET /admin/profit-report; spec
// docs/superpowers/specs/2026-10-14-admin-finance-pages-design.md §4). The
// service sums integer cents in SQL; these turn them into the response, so
// every figure is divided by 100 exactly once.

/** One direction of real money through the gateway, in cents. `feeCents`
 *  covers only rows whose net (and gross) is on file; `missingFees` counts
 *  the others, so the fee is a floor whenever it is non-zero. `missingGross`
 *  counts settled rows with no amount on file (a deposit settled by hand), so
 *  the gross is a floor too: NULL is unknown, never zero (the rule in
 *  gateway-settlement.ts). */
export type CashSide = {
  count: number;
  grossCents: number;
  feeCents: number;
  missingFees: number;
  missingGross: number;
};
export type CashCents = { topups: CashSide; withdrawals: CashSide };

export type OwedCents = {
  /** Normal (non-bonus) wallet balance of customers with a real top-up. */
  walletCashCents: number;
  /** Payouts requested but not paid yet (pending or held): the wallet was
   *  debited when they were asked for, so they appear in neither the wallets
   *  nor the withdrawals paid, yet they are still owed. */
  payoutsInFlightCents: number;
  walletBonusCents: number;
  /** Normal balance of customers who never topped up (cannot withdraw). */
  walletNoTopupCents: number;
  cardCount: number;
  deliveringCount: number;
  /** Cards still owed, at the vault sell-back rate. */
  cardSellbackCents: number;
};

/** Money that stayed: top-ups after their fees, minus withdrawals and theirs. */
export const keptCents = (c: CashCents): number =>
  c.topups.grossCents -
  c.topups.feeCents -
  c.withdrawals.grossCents -
  c.withdrawals.feeCents;

const side = (s: CashSide) => ({
  count: s.count,
  gross: s.grossCents / 100,
  fees: s.feeCents / 100,
  missing_fees: s.missingFees,
  missing_gross: s.missingGross,
});

export function profitCash(current: CashCents, previous: CashCents | null) {
  return {
    topups: side(current.topups),
    withdrawals: side(current.withdrawals),
    kept: keptCents(current) / 100,
    // No previous window (all time) is "nothing to compare", never zero.
    previous_kept: previous ? keptCents(previous) / 100 : null,
  };
}

/** What players could still take out, set against ALL-TIME cash kept: a
 *  period's cash minus a lifetime liability would mean nothing. */
export function profitOwed(owed: OwedCents, allTime: CashCents) {
  const totalCents =
    owed.walletCashCents + owed.payoutsInFlightCents + owed.cardSellbackCents;
  const allKept = keptCents(allTime);
  return {
    wallet_cash: owed.walletCashCents / 100,
    wallet_bonus: owed.walletBonusCents / 100,
    wallet_no_topup: owed.walletNoTopupCents / 100,
    payouts_in_flight: owed.payoutsInFlightCents / 100,
    cards: {
      count: owed.cardCount,
      delivering: owed.deliveringCount,
      sellback: owed.cardSellbackCents / 100,
    },
    total: totalCents / 100,
    all_time_kept: allKept / 100,
    if_all_cashed_out: (allKept - totalCents) / 100,
  };
}

/** ledgerReasonTotals rows (each reason's cash part, or the whole row for
 *  promo reasons) → the "where the money moved" lines. Spend is negative in
 *  the ledger and shown positive here. */
export function profitActivity(rows: { reason: string; amount: number }[]) {
  const cents = (reason: string) =>
    Math.round((rows.find((r) => r.reason === reason)?.amount ?? 0) * 100);
  return {
    // 0 − x, not −x: an empty period must read 0, never −0.
    pack_sales: (0 - cents('pack_open')) / 100,
    sellbacks: cents('buyback') / 100,
    promo_given:
      (cents('bonus_grant') +
        cents('reward_credit') +
        cents('voucher_claim') +
        cents('daily_reward')) /
      100,
    delivery_fees: (0 - cents('delivery_fee')) / 100,
    referral_commission: cents('referral_commission') / 100,
    adjustments: cents('adjustment') / 100,
  };
}
