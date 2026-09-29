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

export type StatusTotals = {
  count: number;
  requested: number;
  settled: number;
};

// Table and requested-amount column per gateway flow. Withdrawals are
// requested on `amount` (the debit basis); both record `amount_settled`.
const GATEWAY = {
  deposits: { table: 'gateway_deposit', requested: 'amount_requested' },
  withdrawals: { table: 'gateway_withdrawal', requested: 'amount' },
} as const;

/** Count and requested/settled sums per status over rows (alias g) matching
 *  `filter` and in `statuses`; every listed status is present, zero when
 *  empty. Never selects the bank account columns. */
export async function statusTotals(
  db: ReportDb,
  kind: keyof typeof GATEWAY,
  statuses: readonly string[],
  filter: SqlPart,
): Promise<Record<string, StatusTotals>> {
  const { table, requested } = GATEWAY[kind];
  const { rows } = await db.raw<{
    status: string;
    n: string;
    requested_cents: string;
    settled_cents: string;
  }>(
    'SELECT g.status, COUNT(*)::bigint AS n, ' +
      `COALESCE(SUM(ROUND(g.${requested} * 100)), 0)::bigint AS requested_cents, ` +
      'COALESCE(SUM(ROUND(g.amount_settled * 100)), 0)::bigint AS settled_cents ' +
      `FROM ${table} g WHERE g.deleted_at IS NULL ` +
      `AND g.status IN (${statuses.map(() => '?').join(', ')})` +
      filter.sql +
      ' GROUP BY g.status',
    [...statuses, ...filter.params],
  );
  const found = new Map(rows.map((r) => [r.status, r]));
  return Object.fromEntries(
    statuses.map((status) => {
      const r = found.get(status);
      return [
        status,
        {
          count: Number(r?.n ?? 0),
          requested: Number(r?.requested_cents ?? 0) / 100,
          settled: Number(r?.settled_cents ?? 0) / 100,
        },
      ];
    }),
  );
}
