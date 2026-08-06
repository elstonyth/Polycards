import { MedusaError } from '@medusajs/framework/utils';

/**
 * Parse + bound pagination query params at the route boundary. The service
 * layer also clamps, so this is hygiene (not a live DoS): reject clearly-invalid
 * input (NaN / negative / absurd) with INVALID_DATA instead of silently clamping.
 * Shared so the paged routes can't drift apart — admin audit/commissions plus
 * the store notifications/credits feeds. See plans/008.
 */
export function parsePaginationParams(
  query: { limit?: unknown; offset?: unknown },
  opts: { defaultLimit?: number; maxLimit?: number } = {},
): { limit: number; offset: number } {
  const { defaultLimit = 50, maxLimit = 200 } = opts;
  const limit = Number(query.limit ?? defaultLimit);
  const offset = Number(query.offset ?? 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `limit must be an integer in [1, ${maxLimit}].`,
    );
  }
  if (!Number.isInteger(offset) || offset < 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'offset must be an integer >= 0.',
    );
  }
  return { limit, offset };
}

/**
 * Parse a `?sort=<column>:<asc|desc>` query param against an allowlist.
 *
 * The allowlist is a security boundary, not hygiene: callers feed the returned
 * key into a query builder's `order` option (or, in the ledger's case, into a
 * raw ORDER BY), so it must never be a passthrough. Unknown keys degrade
 * SILENTLY rather than 400-ing — the purchase-invoices precedent: the value is
 * produced by our own admin UI, and an allowlist drift there should degrade the
 * sort, not break the page.
 *
 * A key miss restores the caller's WHOLE default — `fallbackDir` as well as
 * `fallbackKey`. Keeping the requested direction instead would let
 * `?sort=nonsense:asc` flip a route's default order while honouring nothing the
 * caller actually asked for; on the globepay lists that would silently turn a
 * newest-first history view ascending, and on the ledger it would contradict
 * the documented `occurred_at:desc` default. An absent param is the same case.
 */
export function parseSortParam(
  raw: unknown,
  sortable: ReadonlySet<string>,
  fallbackKey: string,
  fallbackDir: 'ASC' | 'DESC' = 'DESC',
): { key: string; dir: 'ASC' | 'DESC' } {
  if (typeof raw !== 'string') return { key: fallbackKey, dir: fallbackDir };
  const [key, dir] = raw.split(':');
  if (!sortable.has(key)) return { key: fallbackKey, dir: fallbackDir };
  return { key, dir: dir === 'asc' ? 'ASC' : 'DESC' };
}
