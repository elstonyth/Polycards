// Pure aggregation over the credit ledger, factored out of the service so it is
// unit-testable without a DB. Money is 2dp MYR decimals; summing in INTEGER
// CENTS avoids the float drift a running decimal sum accumulates over a long
// ledger. `amount` is signed: positive = credit, negative = spend.
//
// Phase 1b adds external-funded tracking: `externalFundedCents` is the signed
// external-funded sen the row added (top-up, +) or consumed (pack_open, −).
// `externalBalanceCents` = remaining unspent external funding (Σ of the column);
// `externalFundedSpendCents` = external consumed by opens = the VIP basis.

export interface LedgerTotals {
  balanceCents: number;
  topupCents: number;
  spendCents: number;
  externalBalanceCents: number;
  externalFundedSpendCents: number;
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
});

export function foldLedgerRow(
  acc: LedgerTotals,
  row: { amount: number; reason: string; externalFundedCents: number },
): LedgerTotals {
  const cents = Math.round(row.amount * 100);
  const ext = Math.round(row.externalFundedCents);
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
  };
}

export function totalsToUsd(t: LedgerTotals): {
  balance: number;
  topupTotal: number;
  spendTotal: number;
  externalFundedSpendTotal: number;
} {
  return {
    balance: t.balanceCents / 100,
    topupTotal: t.topupCents / 100,
    spendTotal: t.spendCents / 100,
    externalFundedSpendTotal: t.externalFundedSpendCents / 100,
  };
}
