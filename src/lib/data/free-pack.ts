/**
 * Free welcome pack badge-state seam (GET /store/free-pack).
 *
 * The free pack is hidden from the public catalog (the backend excludes the
 * `free_welcome` category from /store/packs), so this answer is the badge's —
 * and therefore the pack's — ONLY entry point: `claim` for an eligible
 * customer, `signup` as a logged-out signup hook while a pack is active, else
 * `hidden`. Server-only: the customer JWT lives in the httpOnly cookie and is
 * sent as an explicit bearer (browser auth is CORS-blocked at the verify
 * origin — see data/customer.ts).
 *
 * Never throws and never caches: the badge is an enhancement, so an expired
 * token or an unreachable backend both resolve to `hidden` and the page
 * renders exactly as it does today.
 */
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';
import { parseOne, FreePackSchema } from '@/lib/data/schemas';

/** Badge state for /slots — the union the page passes to the catalog. */
export type FreePackState =
  { mode: 'claim'; slug: string } | { mode: 'signup' } | { mode: 'hidden' };

const HIDDEN: FreePackState = { mode: 'hidden' };

/**
 * Pure mapper, unit-tested: (had a token, parsed answer) → badge state.
 * Guests read ONLY `promo` (the catalog fact); authed customers read ONLY
 * `eligible`+`slug` (the per-customer claim). Neither can leak into the
 * other's branch, so a stray field can never resurrect a spent claim.
 */
export function mapFreePackState(
  hasToken: boolean,
  parsed: { eligible: boolean; slug: string | null; promo?: boolean } | null,
): FreePackState {
  if (!parsed) return HIDDEN;
  if (!hasToken) return parsed.promo ? { mode: 'signup' } : HIDDEN;
  return parsed.eligible && parsed.slug
    ? { mode: 'claim', slug: parsed.slug }
    : HIDDEN;
}

/**
 * Never throws and never caches: any failure is `hidden` and the page
 * renders exactly as it does today.
 */
export async function getFreePackState(): Promise<FreePackState> {
  const token = await getAuthToken();
  try {
    const parsed = parseOne(
      FreePackSchema,
      await sdk.client.fetch('/store/free-pack', {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: 'no-store',
      }),
    );
    return mapFreePackState(Boolean(token), parsed);
  } catch (error) {
    logger.error('[free-pack] state read failed:', error);
    return HIDDEN;
  }
}
