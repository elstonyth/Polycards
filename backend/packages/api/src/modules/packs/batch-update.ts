import type { LedgerSqlManager } from './claim';

/** Rows per statement: two bound values each, far below Postgres's 65535. */
const CHUNK = 1000;

/**
 * Write a different integer to each row of `credit_transaction` in one
 * `UPDATE … FROM (VALUES …)` per chunk, instead of one UPDATE per row.
 * `setSql` assigns `external_funded_cents` from `v.val` (the row's value) and
 * may read the current row as `t`. Ids must be unique: with a repeated id
 * Postgres applies only one of its values. An id with no row changes nothing,
 * as the per-row UPDATE did. Values are always bound, never interpolated.
 */
export async function updateCreditTransactionsById(
  em: LedgerSqlManager,
  setSql:
    | 'external_funded_cents = v.val'
    | 'external_funded_cents = t.external_funded_cents - v.val',
  rows: ReadonlyArray<readonly [id: string, val: number]>,
  chunk = CHUNK,
): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    await em.execute(
      `UPDATE credit_transaction AS t SET ${setSql}, updated_at = now() ` +
        `FROM (VALUES ${part.map(() => '(?, ?::bigint)').join(', ')}) AS v(id, val) ` +
        'WHERE t.id = v.id',
      part.flat(),
    );
  }
}
