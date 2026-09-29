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

/** Ledger totals per Malaysia calendar day, oldest first; a day with no
 *  ledger rows is left out. */
export async function ledgerTotalsByDay(
  db: ReportDb,
  filter: SqlPart,
): Promise<Array<{ day: string; totals: LedgerTotals }>> {
  const { rows } = await db.raw<ReasonCents & { day: string }>(
    "SELECT to_char(ct.created_at AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYYY-MM-DD') AS day, " +
      'ct.reason, COALESCE(SUM(ROUND(ct.amount * 100)), 0)::bigint AS cents ' +
      'FROM credit_transaction ct WHERE ct.deleted_at IS NULL' +
      filter.sql +
      ' GROUP BY 1, 2 ORDER BY 1',
    filter.params,
  );
  const byDay = new Map<string, ReasonCents[]>();
  for (const r of rows) byDay.set(r.day, [...(byDay.get(r.day) ?? []), r]);
  return [...byDay].map(([day, dayRows]) => ({
    day,
    totals: foldTotals(dayRows),
  }));
}
