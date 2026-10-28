import {
  EMPTY_TOTALS,
  foldLedgerRow,
  forPacksCents,
  totalsToUsd,
  type LedgerTotals,
} from "../credit-summary";

function foldAll(
  rows: { amount: number; reason: string; externalFundedCents: number }[],
): LedgerTotals {
  return rows.reduce(foldLedgerRow, EMPTY_TOTALS);
}

describe("foldLedgerRow — bonus credit (spec 2026-10-07)", () => {
  const fold = (rows: Parameters<typeof foldLedgerRow>[1][]) =>
    rows.reduce(foldLedgerRow, EMPTY_TOTALS);

  it("tracks the bonus balance and keeps bonus-funded opens out of the VIP basis", () => {
    const t = fold([
      { amount: 270, reason: "bonus_grant", externalFundedCents: 0, bonusCents: 27000 },
      { amount: 100, reason: "topup", externalFundedCents: 10000 },
      // RM 300 open: RM 270 bonus first, RM 30 normal.
      { amount: -300, reason: "pack_open", externalFundedCents: -3000, bonusCents: -27000 },
      // its sell-back, 90% of it bonus
      { amount: 250, reason: "buyback", externalFundedCents: null, bonusCents: 22500 },
    ]);
    expect(t.balanceCents).toBe(32000);
    expect(t.bonusBalanceCents).toBe(22500);
    expect(t.vipSpendCents).toBe(3000); // the normal RM 30 only
    expect(totalsToUsd(t).bonusBalance).toBe(225);
  });

  it("adds a sale from bonus play to the playthrough basis (2026-10-09)", () => {
    const t = fold([
      // A gifted card sells for RM 270: normal credit, all of it to play through.
      { amount: 270, reason: "buyback", externalFundedCents: 27000 },
      { amount: -100, reason: "pack_open", externalFundedCents: -10000 },
    ]);
    expect(t.bonusBalanceCents).toBe(0);
    expect(t.depositedPlaythroughCents).toBe(27000);
    expect(t.externalFundedSpendCents).toBe(10000);
    expect(t.externalBalanceCents).toBe(17000);
  });

  it("nets a reversed bonus open back out of both", () => {
    const t = fold([
      { amount: 300, reason: "bonus_grant", externalFundedCents: 0, bonusCents: 30000 },
      { amount: -300, reason: "pack_open", externalFundedCents: 0, bonusCents: -30000 },
      { amount: 300, reason: "pack_open", externalFundedCents: 0, bonusCents: 30000 },
    ]);
    expect(t.bonusBalanceCents).toBe(30000);
    expect(t.vipSpendCents).toBe(0);
  });
});

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
      bonusBalance: 0,
      packSpendTotal: 125,
      withdrawnTotal: 0,
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

// The history's per-row "for packs" marks (spec 2026-10-15 §5): each row's move
// into (+) or out of (−) "still to use on packs". They must add up to the
// wallet's playthrough.deposited − used, or the marks explain a number the
// wallet does not show.
describe("forPacksCents — per-row move of still-to-use-on-packs", () => {
  it("a top-up with a basis adds its whole amount", () => {
    expect(
      forPacksCents({ amount: 50, reason: "topup", externalFundedCents: 5000 }),
    ).toBe(5000);
  });

  it("a pre-1b top-up (NULL basis) is grandfathered out, like the wallet", () => {
    expect(
      forPacksCents({ amount: 50, reason: "topup", externalFundedCents: null }),
    ).toBe(0);
  });

  it("a stamped sell-back adds its stamp; an unstamped one adds nothing", () => {
    expect(
      forPacksCents({ amount: 20, reason: "buyback", externalFundedCents: 2000 }),
    ).toBe(2000);
    expect(
      forPacksCents({ amount: 30, reason: "buyback", externalFundedCents: 0 }),
    ).toBe(0);
    expect(
      forPacksCents({ amount: 30, reason: "buyback", externalFundedCents: null }),
    ).toBe(0);
  });

  it("a pack open takes the external money it consumed; its reversal gives it back", () => {
    expect(
      forPacksCents({ amount: -45, reason: "pack_open", externalFundedCents: -3000 }),
    ).toBe(-3000);
    expect(
      forPacksCents({ amount: 45, reason: "pack_open", externalFundedCents: 3000 }),
    ).toBe(3000);
    // fully paid with bonus / winnings: no for-packs money moved
    expect(
      forPacksCents({ amount: -45, reason: "pack_open", externalFundedCents: 0 }),
    ).toBe(0);
  });

  it("leaves every other row unmarked", () => {
    for (const reason of ["cashout", "adjustment", "bonus_grant", "reward_credit", "delivery_fee"]) {
      expect(
        forPacksCents({ amount: -10, reason, externalFundedCents: 0 }),
      ).toBe(0);
    }
  });

  it("the marks add up to deposited − used (the spec example)", () => {
    // Top up 50, open 45, sell the pull for 30 (not held), sell a free-pack
    // pull for 20 (held in full) → RM 25 still to use on packs.
    const rows = [
      { amount: 50, reason: "topup", externalFundedCents: 5000 },
      { amount: -45, reason: "pack_open", externalFundedCents: -4500 },
      { amount: 30, reason: "buyback", externalFundedCents: 0 },
      { amount: 20, reason: "buyback", externalFundedCents: 2000 },
    ];
    const t = rows.reduce(foldLedgerRow, EMPTY_TOTALS);
    const marks = rows.reduce((s, r) => s + forPacksCents(r), 0);
    expect(marks).toBe(2500);
    expect(marks).toBe(t.depositedPlaythroughCents - t.externalFundedSpendCents);
  });
});

describe("foldLedgerRow — the history's Spent on packs / Withdrawn split", () => {
  const fold = (rows: Parameters<typeof foldLedgerRow>[1][]) =>
    rows.reduce(foldLedgerRow, EMPTY_TOTALS);

  it("Spent on packs counts the whole open, bonus part included, net of reversals", () => {
    const t = fold([
      // RM 45 pack: RM 15 bonus + RM 30 own money → RM 45 spent on packs.
      { amount: -45, reason: "pack_open", externalFundedCents: -3000, bonusCents: -1500 },
      // an aborted RM 10 open and its reversal net out
      { amount: -10, reason: "pack_open", externalFundedCents: -1000 },
      { amount: 10, reason: "pack_open", externalFundedCents: 1000 },
      // delivery fees and withdrawals are not pack spend
      { amount: -15, reason: "delivery_fee", externalFundedCents: 0 },
      { amount: -100, reason: "cashout", externalFundedCents: 0 },
    ]);
    expect(t.packSpendCents).toBe(4500);
    expect(t.vipSpendCents).toBe(3000); // VIP still counts the normal part only
    expect(totalsToUsd(t).packSpendTotal).toBe(45);
  });

  it("Withdrawn counts cashouts and nets a refunded one back out", () => {
    const t = fold([
      { amount: -100, reason: "cashout", externalFundedCents: 0 },
      { amount: -50, reason: "cashout", externalFundedCents: 0 },
      { amount: 50, reason: "cashout", externalFundedCents: 0 }, // payout refused, refunded
      { amount: -45, reason: "pack_open", externalFundedCents: 0 },
    ]);
    expect(t.withdrawnCents).toBe(10000);
    expect(totalsToUsd(t).withdrawnTotal).toBe(100);
  });
});
