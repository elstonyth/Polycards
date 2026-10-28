// Pure aggregation over the credit ledger, factored out of the service so it is
// unit-testable without a DB. Money is 2dp MYR decimals; summing in INTEGER
// CENTS avoids the float drift a running decimal sum accumulates over a long
// ledger. `amount` is signed: positive = credit, negative = spend.
//
// Phase 1b adds external-funded tracking: `externalFundedCents` is the signed
// external-funded sen the row added (top-up, +) or consumed (pack_open, −).
// `externalBalanceCents` = remaining unspent external funding (Σ of the column);
// `externalFundedSpendCents` = external consumed by opens = the VIP basis.
//
// service.ts's `creditSummary` no longer calls this fold at request time — it
// runs the exact same arithmetic as ONE SQL aggregate (audit 2026-07-07 #5).
// This file stays as the unit-tested oracle; the integration test
// "creditSummary — SQL matches the unit-tested fold" in
// pull-status-transitions.spec.ts proves the SQL and this fold agree.

export interface LedgerTotals {
  balanceCents: number;
  topupCents: number;
  spendCents: number;
  externalBalanceCents: number;
  externalFundedSpendCents: number;
  // VIP turnover basis (2026-07-22): net pack_open spend in cents regardless of
  // funding source — winnings-funded opens count toward VIP. Reversal rows
  // (amount>0, reason pack_open) net it back down. Promo grants and the
  // withdrawal playthrough gate still use the external-funded fields above.
  vipSpendCents: number;
  // Plan 033/038 playthrough basis: topups that carry a non-null external basis
  // (external_funded_cents IS NOT NULL), grandfathering pre-1b NULL-basis deposits
  // OUT. NOT topupCents (which counts every positive topup regardless of basis).
  depositedPlaythroughCents: number;
  // Bonus Balance (spec 2026-10-07): Σ bonus_cents — spend-only credit inside
  // balanceCents. vipSpendCents above counts only the normal part of opens.
  bonusBalanceCents: number;
  // The history's "Spent on packs" (2026-10-15): net pack_open spend, its
  // bonus part INCLUDED (unlike vipSpendCents); reversals net it down.
  packSpendCents: number;
  // The history's "Withdrawn": Σ cashout normal part negated
  // (PLAYER_LEDGER_SUMS.withdrawn) — a refunded withdrawal (+cashout) nets out.
  withdrawnCents: number;
}

// Frozen: this is the shared fold SEED. foldLedgerRow is non-mutating today, but
// freezing makes any future in-place mutation fail loudly instead of silently
// corrupting the singleton across concurrent requests.
export const EMPTY_TOTALS: Readonly<LedgerTotals> = Object.freeze({
  balanceCents: 0,
  topupCents: 0,
  spendCents: 0,
  externalBalanceCents: 0,
  externalFundedSpendCents: 0,
  vipSpendCents: 0,
  depositedPlaythroughCents: 0,
  bonusBalanceCents: 0,
  packSpendCents: 0,
  withdrawnCents: 0,
});

export function foldLedgerRow(
  acc: LedgerTotals,
  // externalFundedCents is nullable so the fold can tell a pre-1b NULL-basis row
  // apart from a real 0 — the deposited-playthrough basis counts only NON-null
  // topups (SQL: external_funded_cents IS NOT NULL). Callers must pass the raw
  // column, NOT null-coerced-to-0, or the grandfathering distinction is lost.
  row: {
    amount: number;
    reason: string;
    externalFundedCents: number | null;
    bonusCents?: number | null;
  },
): LedgerTotals {
  const cents = Math.round(row.amount * 100);
  const ext = Math.round(row.externalFundedCents ?? 0);
  const bonus = Math.round(row.bonusCents ?? 0);
  // A pack_open row stores the consumed external as NEGATIVE sen; a reversal
  // stores it back as POSITIVE. Count BOTH signs (flip), so a reversed open
  // subtracts exactly what the open added — the VIP basis nets to zero. Other
  // reasons never touch the basis.
  const externalConsumed = row.reason === "pack_open" ? -ext : 0;
  return {
    balanceCents: acc.balanceCents + cents,
    topupCents:
      acc.topupCents + (cents > 0 && row.reason === "topup" ? cents : 0),
    spendCents: acc.spendCents + (cents < 0 ? -cents : 0),
    externalBalanceCents: acc.externalBalanceCents + ext,
    externalFundedSpendCents: acc.externalFundedSpendCents + externalConsumed,
    vipSpendCents:
      acc.vipSpendCents + (row.reason === "pack_open" ? -cents + bonus : 0),
    // Mirrors SQL DEPOSITED_PT_SEN_SQL: a topup with amount>0 AND
    // external_funded_cents IS NOT NULL (a NULL-basis pre-1b topup is
    // grandfathered OUT — gate on `!= null`, not `> 0`), plus a buyback's
    // stamped share from bonus or welcome play (2026-10-09; gift and reward
    // sales stamp only before 2026-10-15, ADR 0012).
    depositedPlaythroughCents:
      acc.depositedPlaythroughCents +
      (cents > 0 &&
      row.reason === "topup" &&
      row.externalFundedCents != null
        ? cents
        : row.reason === "buyback"
          ? ext
          : 0),
    bonusBalanceCents: acc.bonusBalanceCents + bonus,
    packSpendCents:
      acc.packSpendCents + (row.reason === "pack_open" ? -cents : 0),
    withdrawnCents:
      acc.withdrawnCents + (row.reason === "cashout" ? bonus - cents : 0),
  };
}

/** One ledger row's move into (+) or out of (−) the wallet's "still to use
 *  on packs", in sen (spec 2026-10-15 §5), so the history can mark each row
 *  and the marks add up to playthrough.deposited − used. Deposited side
 *  mirrors DEPOSITED_PT_SEN_SQL (a top-up with a basis, a stamped sell-back);
 *  used side mirrors used_cents (a pack open's stored, negative consumption —
 *  its reversal row stores it back positive). Every other row is 0. */
export function forPacksCents(row: {
  amount: number;
  reason: string;
  externalFundedCents: number | null;
}): number {
  const ext = Math.round(row.externalFundedCents ?? 0);
  if (row.reason === "topup")
    return row.amount > 0 && row.externalFundedCents != null
      ? Math.round(row.amount * 100)
      : 0;
  if (row.reason === "buyback") return Math.max(0, ext);
  if (row.reason === "pack_open") return ext;
  return 0;
}

export function totalsToUsd(t: LedgerTotals): {
  balance: number;
  topupTotal: number;
  spendTotal: number;
  externalFundedSpendTotal: number;
  vipSpendTotal: number;
  depositedPlaythroughTotal: number;
  bonusBalance: number;
  packSpendTotal: number;
  withdrawnTotal: number;
} {
  return {
    balance: t.balanceCents / 100,
    topupTotal: t.topupCents / 100,
    spendTotal: t.spendCents / 100,
    externalFundedSpendTotal: t.externalFundedSpendCents / 100,
    vipSpendTotal: t.vipSpendCents / 100,
    depositedPlaythroughTotal: t.depositedPlaythroughCents / 100,
    bonusBalance: t.bonusBalanceCents / 100,
    packSpendTotal: t.packSpendCents / 100,
    withdrawnTotal: t.withdrawnCents / 100,
  };
}
