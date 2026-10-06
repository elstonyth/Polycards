// Bonus credit (泥码) — the spend-only slice of a customer's credit. Pure sen
// math, DB-free like external-funded.ts so the rules are unit-testable. All
// inputs/outputs are integer sen unless the name says Myr. Spec 2026-10-07 §4.
//
// The ledger stamps every row's bonus part in credit_transaction.bonus_cents
// (signed: + adds to the bonus balance, − spends it). An open spends bonus
// FIRST; each pull remembers the share of its price that was bonus
// (pull.bonus_bp), and a sell-back pays that same share back as bonus, so the
// value of a bonus grant or a gifted pack never becomes withdrawable.

/** The refusal when a debit other than a pack open would need bonus credit
 *  (delivery fee, withdrawal, admin deduction): the balance covers it, the
 *  normal part does not. */
export const BONUS_NOT_SPENDABLE_MESSAGE =
  "Bonus credit can only be spent on packs — it can't pay for this.";

/** A gifted pack's pull sells back entirely as bonus. */
export const BONUS_BP_FULL = 10_000;

/** Bonus spent by an open of `totalSen`: bonus first, capped both ways. */
export function consumeBonusSen(
  totalSen: number,
  bonusBalanceSen: number,
): number {
  return Math.max(0, Math.min(totalSen, bonusBalanceSen));
}

/** A batch's bonus split over its paid rows in row order (at most one row is
 *  partial), so each pull can carry its own bonus share. */
export function allocateBonusSen(
  priceSen: number,
  rows: number,
  bonusSen: number,
): number[] {
  let left = Math.max(0, bonusSen);
  return Array.from({ length: rows }, () => {
    const take = Math.min(priceSen, left);
    left -= take;
    return take;
  });
}

// Integer ceiling division: rounding always lands on the BONUS side, so a
// rounding error can only keep value spend-only, never make it withdrawable.
const ceilDiv = (a: number, b: number) => Math.floor((a + b - 1) / b);

/** Share of a row's price paid in bonus, in basis points (rounded up). */
export function bonusBpFor(bonusSen: number, priceSen: number): number {
  if (priceSen <= 0 || bonusSen <= 0) return 0;
  return Math.min(BONUS_BP_FULL, ceilDiv(bonusSen * BONUS_BP_FULL, priceSen));
}

/** The bonus part of a sell-back of `amountSen` (rounded up). */
export function bonusShareSen(amountSen: number, bp: number): number {
  const clamped = Math.max(0, Math.min(BONUS_BP_FULL, bp));
  if (amountSen <= 0 || clamped === 0) return 0;
  return ceilDiv(amountSen * clamped, BONUS_BP_FULL);
}

export function bonusShareMyr(amount: number, bp: number): number {
  return bonusShareSen(Math.round(amount * 100), bp) / 100;
}

/** A pull's source from how its row was paid: a gift, any bonus, or neither.
 *  Only 'pack' counts toward the boards, tasks, VIP and the welcome unlock. */
export function pullSourceFor(row: {
  gift: boolean;
  bonusSen: number;
}): 'gift' | 'bonus' | 'pack' {
  if (row.gift) return 'gift';
  return row.bonusSen > 0 ? 'bonus' : 'pack';
}
