import { MedusaError } from '@medusajs/framework/utils';
import {
  ledgerTotals,
  type LedgerTotals,
} from '../../../modules/packs/economy';
import { EFFECTIVE_GROUP_SQL, type ReportDb, type SqlPart } from '../sql';

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

/**
 * Pack sales: revenue per pack from pack_open ledger rows (alias ct,
 * filtered by `ledger`), linked to a pack through the open's pulls
 * (credit_transaction.source_transaction_id = pull.open_id). Packs opened =
 * paid pulls (alias p, filtered by `pulls`). A charge with no linked pull
 * (rows from before open_id, or an open that never produced pulls) is
 * unattributed, so every pack plus unattributed equals economy revenue.
 * ponytail: the DISTINCT scans pull.open_id, which has no index; fine at
 * report frequency. Add an index on pull(open_id) if this reaches slow logs.
 */
export async function packSales(
  db: ReportDb,
  ledger: SqlPart,
  pulls: SqlPart,
): Promise<{
  bySlug: Map<string, { opened: number; cents: number }>;
  unattributedCents: number;
}> {
  const revenue = await db.raw<{ pack_id: string | null; cents: string }>(
    'SELECT op.pack_id, COALESCE(SUM(ROUND(ct.amount * 100)), 0)::bigint AS cents ' +
      'FROM credit_transaction ct ' +
      'LEFT JOIN (SELECT DISTINCT open_id, pack_id FROM pull ' +
      'WHERE open_id IS NOT NULL AND deleted_at IS NULL) op ' +
      'ON op.open_id = ct.source_transaction_id ' +
      "WHERE ct.deleted_at IS NULL AND ct.reason = 'pack_open'" +
      ledger.sql +
      ' GROUP BY op.pack_id',
    ledger.params,
  );
  const opened = await db.raw<{ pack_id: string; n: string }>(
    'SELECT p.pack_id, COUNT(*)::bigint AS n FROM pull p ' +
      "WHERE p.deleted_at IS NULL AND p.source = 'pack'" +
      pulls.sql +
      ' GROUP BY p.pack_id',
    pulls.params,
  );
  const bySlug = new Map<string, { opened: number; cents: number }>();
  let unattributedCents = 0;
  for (const r of revenue.rows) {
    // Ledger rows are negative for a charge; revenue reads positive.
    const cents = -Number(r.cents);
    if (r.pack_id === null) unattributedCents += cents;
    else bySlug.set(r.pack_id, { opened: 0, cents });
  }
  for (const r of opened.rows) {
    const row = bySlug.get(r.pack_id) ?? { opened: 0, cents: 0 };
    bySlug.set(r.pack_id, { ...row, opened: Number(r.n) });
  }
  return { bySlug, unattributedCents };
}

/** Live players per effective group; players with no row are DEFAULT. */
export async function groupSizes(
  db: ReportDb,
): Promise<{ defaultPlayers: number; byGroup: Map<string, number> }> {
  const { rows } = await db.raw<{ group_id: string | null; n: string }>(
    'SELECT eff.group_id, COUNT(*)::bigint AS n FROM customer c ' +
      `LEFT JOIN (${EFFECTIVE_GROUP_SQL}) eff ON eff.customer_id = c.id ` +
      'WHERE c.deleted_at IS NULL GROUP BY eff.group_id',
  );
  let defaultPlayers = 0;
  const byGroup = new Map<string, number>();
  for (const r of rows) {
    if (r.group_id === null) defaultPlayers = Number(r.n);
    else byGroup.set(r.group_id, Number(r.n));
  }
  return { defaultPlayers, byGroup };
}
