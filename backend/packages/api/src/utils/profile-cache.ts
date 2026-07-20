import { Modules } from '@medusajs/framework/utils';
import type { MedusaContainer } from '@medusajs/framework/types';

// Per-process cache of the public-profile body (GET /store/profiles/:handle),
// the leaderboard pattern: profile stats are per-customer aggregates over the
// pull/ledger history, too expensive to recompute on every render of /me and
// /profile/:handle. Upgrade to Redis if we ever run >1 backend instance —
// invalidation below is per-process, so a second instance would still serve
// its own copy for up to the TTL.
//
// It lives here rather than inside the route module so the MUTATIONS that must
// be visible immediately (the vault showcase toggle) can evict the entry
// without importing a route file.
const CACHE_TTL_MS = 30_000;
const profileCache = new Map<string, { expires: number; body: unknown }>();

/** The cached body for a handle, or undefined when absent/expired. */
export function getCachedProfile(handle: string): unknown | undefined {
  const hit = profileCache.get(handle);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) {
    profileCache.delete(handle);
    return undefined;
  }
  return hit.body;
}

export function setCachedProfile(handle: string, body: unknown): void {
  profileCache.set(handle, { expires: Date.now() + CACHE_TTL_MS, body });
}

/** Test seam: module state outlives a test's fixtures — the http suite runs in
 *  one process, so test A's cached profile would be served to test B. */
export function clearProfileCache(): void {
  profileCache.clear();
}

/**
 * Drop the cached profile of the customer that just changed something the
 * public profile renders (showcase toggle, avatar, frame). Best-effort: a
 * customer without a handle has nothing cached, and a failed lookup only
 * means the old ≤30s staleness — never a failed mutation, so callers don't
 * need to guard it.
 */
export async function invalidateProfileForCustomer(
  scope: MedusaContainer,
  customerId: string,
): Promise<void> {
  try {
    const customers = scope.resolve(Modules.CUSTOMER);
    const customer = await customers.retrieveCustomer(customerId, {
      select: ['id', 'metadata'],
    });
    const handle = ((customer?.metadata ?? {}) as Record<string, unknown>)[
      'handle'
    ];
    if (typeof handle === 'string' && handle !== '') {
      profileCache.delete(handle);
    }
  } catch {
    // Swallowed on purpose — see the doc comment.
  }
}
