// Pure available/locked fold (DB-free, unit-testable; mirrors the
// lockedCommissionCents SQL). A commission credit is LOCKED — not yet spendable —
// only while it is 'pending' AND not yet matured (now < matures_at), OR
// 'suspended'. 'available' and 'reversed' are NOT locked: 'available' is the
// post-maturity spendable state, and a 'reversed' commission's positive credit is
// already netted by its negative reversal row in the raw balance (locking it too
// would double-subtract). Maturity is a READ-TIME predicate on 'pending' — a
// lagging maturity job can't wrongly lock a matured 'pending' row. Amounts are
// integer minor units (cents = sen; MYR × 100).
export type CommissionLockRow = {
  status: string;
  matures_at_ms: number;
  amount_cents: number;
};

export function lockedCentsFromCommissions(
  rows: CommissionLockRow[],
  nowMs: number,
): number {
  let locked = 0;
  for (const r of rows) {
    const immaturePending = r.status === 'pending' && nowMs < r.matures_at_ms;
    const heldBySuspension = r.status === 'suspended';
    if (immaturePending || heldBySuspension) locked += Math.max(0, r.amount_cents);
  }
  return locked;
}
