import { MedusaError } from '@medusajs/framework/utils';

/**
 * Parse + bound admin pagination query params at the route boundary. The service
 * layer also clamps, so this is hygiene (not a live DoS): reject clearly-invalid
 * input (NaN / negative / absurd) with INVALID_DATA instead of silently clamping.
 * Shared so the audit/commissions routes can't drift apart. See plans/008.
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
