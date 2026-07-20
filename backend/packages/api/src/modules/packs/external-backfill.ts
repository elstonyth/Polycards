// Pure replay of external-funded stamping over a customer's chronological
// ledger — the backfill oracle for pre-1b rows (topups/opens written before
// Migration20260621120000 added external_funded_cents, which the live paths
// grandfather out as NULL). Re-derives every topup/pack_open stamp with the
// SAME arithmetic the live paths use (mutateCreditAtomic stamps a topup as
// +amount; settleOpen consumes via consumeExternalSen; reverseCreditTransaction
// mirrors the original), so running it over an already-correct ledger yields an
// empty diff. DB-free, like credit-summary.ts / vip-lifetime.ts.
import { consumeExternalSen } from './external-funded';

export type BackfillLedgerRow = {
  id: string;
  reason: string;
  /** Signed 2dp MYR. */
  amount: number;
  external_funded_cents: number | null;
  /** Reversal rows carry `reversal:<originalRowId>`. */
  reference: string | null;
};

/**
 * Rows MUST be one customer's ledger in chronological order (created_at, id).
 * Returns id → recomputed external_funded_cents for every topup/pack_open row
 * whose stored value differs (NULL counts as differing — the grandfather flip
 * is the point). Other reasons are never touched: buyback / commission /
 * adjustment / voucher income is internal by design and carries no basis.
 */
export function recomputeExternalStamps(
  rows: BackfillLedgerRow[],
): Map<string, number> {
  let balanceSen = 0;
  const extById = new Map<string, number>();
  const diff = new Map<string, number>();

  for (const row of rows) {
    let ext: number;
    if (row.reason === 'topup' && row.amount > 0) {
      ext = Math.round(row.amount * 100);
      balanceSen += ext;
    } else if (row.reason === 'pack_open' && row.amount < 0) {
      const consumed = consumeExternalSen(
        Math.round(-row.amount * 100),
        balanceSen,
      );
      ext = consumed > 0 ? -consumed : 0; // avoid JS -0
      balanceSen -= consumed;
    } else if (row.reason === 'pack_open' && row.amount > 0) {
      // Reversal: mirror the original's (recomputed) stamp, restoring balance.
      const originalId = row.reference?.startsWith('reversal:')
        ? row.reference.slice('reversal:'.length)
        : null;
      ext = -(extById.get(originalId ?? '') ?? 0) || 0; // -0 → 0
      balanceSen += ext;
    } else {
      continue;
    }
    extById.set(row.id, ext);
    if ((row.external_funded_cents ?? null) !== ext) {
      diff.set(row.id, ext);
    }
  }
  return diff;
}
