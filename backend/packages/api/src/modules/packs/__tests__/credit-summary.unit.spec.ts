import {
  EMPTY_TOTALS,
  foldLedgerRow,
  totalsToUsd,
  type LedgerTotals,
} from "../credit-summary";

function foldAll(
  rows: { amount: number; reason: string; externalFundedCents: number }[],
): LedgerTotals {
  return rows.reduce(foldLedgerRow, EMPTY_TOTALS);
}

describe("foldLedgerRow + totalsToUsd (external-funded)", () => {
  it("accumulates balance, topup, spend, external balance and external spend", () => {
    // topup RM100 (external +10000), open RM75 consuming 7500 external,
    // buyback +RM45 (external 0), open RM50 consuming the remaining 2500 external.
    const rows = [
      { amount: 100, reason: "topup", externalFundedCents: 10000 },
      { amount: -75, reason: "pack_open", externalFundedCents: -7500 },
      { amount: 45, reason: "buyback", externalFundedCents: 0 },
      { amount: -50, reason: "pack_open", externalFundedCents: -2500 },
    ];
    const t = foldAll(rows);
    expect(t.balanceCents).toBe(2000); // 10000 - 7500 + 4500 - 5000
    expect(t.topupCents).toBe(10000);
    expect(t.spendCents).toBe(12500); // |−75| + |−50|
    expect(t.externalBalanceCents).toBe(0); // 10000 − 7500 − 2500
    expect(t.externalFundedSpendCents).toBe(10000); // 7500 + 2500 consumed
    expect(t.vipSpendCents).toBe(12500); // turnover: FULL open spend, funding-blind
    expect(totalsToUsd(t)).toEqual({
      balance: 20,
      topupTotal: 100,
      spendTotal: 125,
      externalFundedSpendTotal: 100,
      vipSpendTotal: 125,
      depositedPlaythroughTotal: 100, // the RM100 topup carries a non-null basis
    });
  });

  // Plan 033/038 grandfathering: a topup with a NULL external basis (pre-1b) is
  // counted as a topup but NOT into the deposited-playthrough basis — this is the
  // only case that distinguishes the `!= null` gate from a `> 0` one.
  it("excludes a NULL-basis topup from depositedPlaythrough but counts it as a topup", () => {
    const t = foldLedgerRow(EMPTY_TOTALS, {
      amount: 40,
      reason: "topup",
      externalFundedCents: null,
    });
    expect(t.topupCents).toBe(4000); // still a topup
    expect(t.depositedPlaythroughCents).toBe(0); // grandfathered out of the basis
    expect(t.externalBalanceCents).toBe(0); // null coerces to 0 external
  });

  it("treats a missing/NULL external column (old rows) as zero external", () => {
    const t = foldLedgerRow(EMPTY_TOTALS, {
      amount: -10,
      reason: "pack_open",
      externalFundedCents: 0,
    });
    expect(t.externalFundedSpendCents).toBe(0);
    expect(t.spendCents).toBe(1000);
  });

  it("only pack_open rows contribute to external spend, not adjustments", () => {
    const t = foldAll([
      { amount: -3, reason: "adjustment", externalFundedCents: 0 },
      { amount: -10, reason: "pack_open", externalFundedCents: -1000 },
    ]);
    expect(t.externalFundedSpendCents).toBe(1000);
  });

  // Regression (restored from the pre-1b suite): a POSITIVE adjustment is a
  // credit to balance only — never a top-up, a spend, or external funding.
  it("treats a positive adjustment as a credit but not a top-up, spend, or external", () => {
    const t = foldLedgerRow(EMPTY_TOTALS, {
      amount: 5,
      reason: "adjustment",
      externalFundedCents: 0,
    });
    expect(t.balanceCents).toBe(500);
    expect(t.topupCents).toBe(0);
    expect(t.spendCents).toBe(0);
    expect(t.externalBalanceCents).toBe(0);
    expect(t.externalFundedSpendCents).toBe(0);
  });

  it("the invariant externalSpend + externalBalance == external-in holds", () => {
    const rows = [
      { amount: 60, reason: "topup", externalFundedCents: 6000 },
      { amount: -25, reason: "pack_open", externalFundedCents: -2500 },
    ];
    const t = foldAll(rows);
    expect(t.externalFundedSpendCents + t.externalBalanceCents).toBe(6000);
  });

  it("defensive coercion: undefined/null external_funded_cents coerces to 0 (matches service.ts read)", () => {
    const coerce = (v: unknown) => Number((v as number | null | undefined) ?? 0);
    expect(coerce(undefined)).toBe(0);
    expect(coerce(null)).toBe(0);
    const t = foldLedgerRow(EMPTY_TOTALS, {
      amount: -10,
      reason: "pack_open",
      externalFundedCents: coerce(undefined),
    });
    expect(t.externalFundedSpendCents).toBe(0);
    expect(t.spendCents).toBe(1000);
  });

  it("avoids float drift on sub-cent amounts", () => {
    const t = foldAll([
      { amount: 0.1, reason: "topup", externalFundedCents: 10 },
      { amount: 0.2, reason: "topup", externalFundedCents: 20 },
    ]);
    expect(t.balanceCents).toBe(30);
    expect(totalsToUsd(t).balance).toBe(0.3);
  });

  // Turnover-VIP (2026-07-22): a fully winnings-funded open (external 0) still
  // counts its FULL amount toward the VIP turnover basis.
  it("a winnings-funded open counts toward vipSpend but not external spend", () => {
    const t = foldAll([
      { amount: 45, reason: "buyback", externalFundedCents: 0 },
      { amount: -40, reason: "pack_open", externalFundedCents: 0 },
    ]);
    expect(t.externalFundedSpendCents).toBe(0); // no deposit consumed
    expect(t.vipSpendCents).toBe(4000); // full open counts toward VIP
  });

  it("a positive-external pack_open reversal nets the VIP basis back to zero", () => {
    // open RM75 consuming 7500 external, then a compensating +RM75 pack_open row
    // carrying +7500 external (the reversal). Basis must return to 0.
    const t = foldAll([
      { amount: 100, reason: "topup", externalFundedCents: 10000 },
      { amount: -75, reason: "pack_open", externalFundedCents: -7500 },
      { amount: 75, reason: "pack_open", externalFundedCents: 7500 },
    ]);
    expect(t.externalFundedSpendCents).toBe(0); // -(-7500) + -(+7500) = 0
    expect(t.vipSpendCents).toBe(0); // turnover nets to zero on reversal too
    expect(t.externalBalanceCents).toBe(10000); // external balance fully restored
    expect(t.balanceCents).toBe(10000); // net wallet unchanged by the round-trip
  });
});
