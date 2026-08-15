/**
 * Free welcome pack eligibility seam (GET /store/free-pack).
 *
 * The free pack is hidden from the public catalog (the backend excludes the
 * `free_welcome` category from /store/packs), so this per-customer answer is the
 * badge's — and therefore the pack's — ONLY entry point. Server-only: the
 * customer JWT lives in the httpOnly cookie and is sent as an explicit bearer
 * (browser auth is CORS-blocked at the verify origin — see data/customer.ts).
 *
 * Never throws and never caches: the badge is an enhancement, so an anonymous
 * visitor, an expired token, or an unreachable backend all resolve to
 * "not eligible" and the page renders exactly as it does today.
 */
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';
import { parseOne, FreePackSchema } from '@/lib/data/schemas';

export type FreePackEligibility = {
  eligible: boolean;
  /** Pack slug to open — non-null whenever `eligible` is true. */
  slug: string | null;
};

const NOT_ELIGIBLE: FreePackEligibility = { eligible: false, slug: null };

export async function getFreePackEligibility(): Promise<FreePackEligibility> {
  const token = await getAuthToken();
  if (!token) return NOT_ELIGIBLE;
  try {
    const parsed = parseOne(
      FreePackSchema,
      await sdk.client.fetch('/store/free-pack', {
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      }),
    );
    // `eligible` without a slug is not an offer — the badge would link nowhere,
    // so treat it as ineligible rather than rendering a dead target.
    if (!parsed?.eligible || !parsed.slug) return NOT_ELIGIBLE;
    return { eligible: true, slug: parsed.slug };
  } catch (error) {
    logger.error('[free-pack] eligibility read failed:', error);
    return NOT_ELIGIBLE;
  }
}
