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
  // Plan 033/038 playthrough basis: topups that carry a non-null external basis
  // (external_funded_cents IS NOT NULL), grandfathering pre-1b NULL-basis deposits
  // OUT. NOT topupCents (which counts every positive topup regardless of basis).
  depositedPlaythroughCents: number;
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
  depositedPlaythroughCents: 0,
});

export function foldLedgerRow(
  acc: LedgerTotals,
  // externalFundedCents is nullable so the fold can tell a pre-1b NULL-basis row
  // apart from a real 0 — the deposited-playthrough basis counts only NON-null
  // topups (SQL: external_funded_cents IS NOT NULL). Callers must pass the raw
  // column, NOT null-coerced-to-0, or the grandfathering distinction is lost.
  row: { amount: number; reason: string; externalFundedCents: number | null },
): LedgerTotals {
  const cents = Math.round(row.amount * 100);
  const ext = Math.round(row.externalFundedCents ?? 0);
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
    // Mirrors SQL DEPOSITED_PT_FILTER: reason='topup' AND amount>0 AND
    // external_funded_cents IS NOT NULL. A NULL-basis (pre-1b) topup is
    // grandfathered OUT — gate on `!= null`, not `> 0`.
    depositedPlaythroughCents:
      acc.depositedPlaythroughCents +
      (cents > 0 &&
      row.reason === "topup" &&
      row.externalFundedCents != null
        ? cents
        : 0),
  };
}

export function totalsToUsd(t: LedgerTotals): {
  balance: number;
  topupTotal: number;
  spendTotal: number;
  externalFundedSpendTotal: number;
  depositedPlaythroughTotal: number;
} {
  return {
    balance: t.balanceCents / 100,
    topupTotal: t.topupCents / 100,
    spendTotal: t.spendCents / 100,
    externalFundedSpendTotal: t.externalFundedSpendCents / 100,
    depositedPlaythroughTotal: t.depositedPlaythroughCents / 100,
  };
}
