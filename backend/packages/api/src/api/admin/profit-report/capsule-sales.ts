import { CAPSULE_SALES_CASH } from '../../../modules/packs/money-figures';
import {
  filterSql,
  type CustomerScope,
} from '../../../modules/packs/real-customers';
import { and, windowFilter, type ReportDb } from '../../reports/sql';
import type { ReportWindow } from '../../reports/params';

/** Lucky Draw capsule sales in the window, cash only, in sen (positive): the
 *  part of Profit's pack_open total that P&L decision 3 counts as Lucky Draw
 *  revenue, not pack sales. */
export async function capsuleSalesSen(
  db: ReportDb,
  window: ReportWindow,
  scope: CustomerScope,
): Promise<number> {
  const part = and(
    windowFilter(window, 'ct.created_at'),
    filterSql(scope, 'ct.customer_id'),
  );
  const { rows } = await db.raw<{ sen: string }>(
    `SELECT COALESCE(SUM(${CAPSULE_SALES_CASH.sen('ct.')}), 0)::bigint AS sen ` +
      'FROM credit_transaction ct ' +
      `WHERE ct.deleted_at IS NULL AND ${CAPSULE_SALES_CASH.where('ct.')}` +
      part.sql,
    part.params,
  );
  return Number(rows[0]?.sen ?? 0);
}
