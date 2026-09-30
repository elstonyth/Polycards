import { Modules } from '@medusajs/framework/utils';
import type { MedusaContainer } from '@medusajs/framework/types';
import { storedHandle } from './profile-handle';

// Per-process cache of the public-profile body (GET /store/profiles/:handle),
// the leaderboard pattern: profile stats are per-customer aggregates over the
// pull/ledger history, too expensive to recompute on every render of /me and
// /profile/:handle. >1 instance since #473: per-process is accepted — the
// invalidation below only clears the writing instance's Map, so a second
// instance still serves its own copy for up to the TTL. Decision + upgrade
// path recorded in plan 116.
//
// Keyed by the PERMANENT handle (utils/profile-handle.ts), so a rename never
// retires a key — it only makes the cached body's display name stale, which
// the eviction below clears on the writing instance and the TTL everywhere
// else. Display-only either way.
// ponytail: fix is a shared invalidation channel (Valkey pub/sub, plan 116's
// upgrade path) — worth it only if the 30s window is actually reported.
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
 * Drop one handle's entry. Case-folded to match the key the route writes —
 * anything else evicts a spelling nobody cached and leaves the live one stale.
 */
export function evictProfileHandle(handle: string | null | undefined): void {
  const key = (handle ?? '').trim().toLowerCase();
  if (key !== '') profileCache.delete(key);
}

/**
 * Drop the cached profile of the customer that just changed something the
 * public profile renders (display name, showcase toggle, avatar, frame,
 * disable). Best-effort: a customer with no handle yet has nothing cached, and
 * a failed lookup only means the old ≤30s staleness — never a failed mutation,
 * so callers don't need to guard it.
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
    evictProfileHandle(storedHandle(customer));
  } catch {
    // Swallowed on purpose — see the doc comment.
  }
}
