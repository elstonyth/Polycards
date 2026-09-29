import { MedusaError } from '@medusajs/framework/utils';
import {
  ledgerTotals,
  type LedgerTotals,
} from '../../../modules/packs/economy';
import type { ReportDb, SqlPart } from '../sql';

export type ReasonCents = { reason: string; cents: string };

// ledgerTotals throws on an unknown reason. Say why, as /admin/economy does
// (a bare Error is masked as "An unknown error occurred.").
export function foldTotals(rows: readonly ReasonCents[]): LedgerTotals {
  try {
    return ledgerTotals(
      rows.map((r) => ({ reason: r.reason, amount: Number(r.cents) / 100 })),
    );
  } catch (err) {
    throw new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      `Report cannot be built (${(err as Error).message}); add the reason to ledgerTotals.`,
    );
  }
}

/**
 * Ledger totals over the credit_transaction rows (alias ct) matching
 * `filter`. The scoped twin of PacksModuleService.ledgerReasonTotals:
 * desk-reports.spec.ts locks group=all to /admin/economy so the two cannot
 * drift.
 */
export async function ledgerTotalsWhere(
  db: ReportDb,
  filter: SqlPart,
): Promise<LedgerTotals> {
  const { rows } = await db.raw<ReasonCents>(
    'SELECT ct.reason, COALESCE(SUM(ROUND(ct.amount * 100)), 0)::bigint AS cents ' +
      'FROM credit_transaction ct WHERE ct.deleted_at IS NULL' +
      filter.sql +
      ' GROUP BY ct.reason',
    filter.params,
  );
  return foldTotals(rows);
}
