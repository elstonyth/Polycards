// Per-process TTL memo for PUBLIC, non-personalised backend reads.
//
// The backend store routes already run this exact pattern (store/pulls/recent
// 5s, store/packs 30s, store/leaderboard 30s), which caps the DB work. What
// they cannot cap is the work the STOREFRONT pays per request: an HTTP hop to
// the backend plus a zod parse of the response — on every SSR render and every
// poll tick. A tab open on the home or a pack page polls /api/recent-pulls
// every 4s (use-recent-pulls), so that cost scales linearly with concurrent
// users while the backend serves the same cached body over and over.
//
// Deliberately a plain Map rather than `unstable_cache`: this has to hold under
// `force-dynamic` pages (most of the storefront reads auth cookies and cannot
// be statically rendered), and Next's Data Cache interacts with route-segment
// cache semantics in ways this repo has already been bitten by — see the
// fetchCache warning in src/app/page.tsx.
//
// Per-process is the point, not a limitation: N storefront instances make N
// backend calls per window instead of N x requests.
//
// STALENESS LADDER (worst case per layer; per instance, 2 instances of
// each app since #473 — layers stack, they do not synchronize):
//   backend route Map        30s (packs list/detail, leaderboard; pulls 5s)
//   this storefront memo     30s (catalog, board) / 15s (pack detail, plus
//                            15s more for the /api/pack-detail body) /
//                            60s (avatar frames)
//   home route cache         15s (src/app/page.tsx revalidate)
//   getPackHighlights        60s (unstable_cache, no tags)
// ⇒ an admin pack edit can take ~60s to reach /slots, ~75s to reach /,
//   ~105s to reach a home chase card. Admin busts clear ONLY the writing
//   backend instance's Maps; the other instance rolls over on TTL.

type Entry = { expires: number; value: Promise<unknown> };

// Every store, so the test seam below can clear them all.
const stores = new Set<Map<string, Entry>>();

/**
 * A bounded memo with its own store. The shared `cached` below is one; a
 * caller whose keys come straight from a URL (card handles) takes its own, so
 * a flood of unique keys evicts only its own entries, never the catalog's.
 */
export function createTtlCache(maxEntries: number) {
  const store = new Map<string, Entry>();
  stores.add(store);
  /**
   * Memoise `load()` under `key` for `ttlMs`.
   *
   * The PROMISE is cached, not the resolved value, so a stampede of concurrent
   * misses (500 pollers arriving in the same millisecond) shares ONE backend call
   * instead of each firing its own — caching after the await would let the whole
   * herd through the gap.
   *
   * A REJECTED promise is evicted rather than served for the rest of the window.
   * That eviction is the ONLY thing standing between a one-second backend blip
   * and a blank catalog for a full window, so callers must let their loader throw
   * and catch the degradation OUTSIDE this call — a loader that catches its own
   * failure and returns `[]` resolves successfully, and nothing here can tell
   * that empty result from a real one. See getPackCategories and getAvatarFrames
   * for the shape.
   */
  return function cached<T>(
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
  ): Promise<T> {
    const hit = store.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;

    const value = load();
    // Delete first: Map.set on an existing key keeps its ORIGINAL position, so
    // without this the hottest keys (inserted at boot, refreshed every window)
    // sat at the front and were the first evicted under pressure.
    store.delete(key);
    store.set(key, { expires: Date.now() + ttlMs, value });
    // Hard bound: keys can be attacker-influenced (recent-pulls' pack_id), and
    // expired entries are otherwise never removed. Map iterates in insertion
    // order and a refresh re-inserts, so this evicts the least recently
    // (re)loaded key — a hot key refreshed each window sits at the back.
    if (store.size > maxEntries) {
      store.delete(store.keys().next().value as string);
    }
    void value.catch(() => {
      // Only evict our own entry — a later window may have replaced it already.
      if (store.get(key)?.value === value) store.delete(key);
    });
    return value;
  };
}

// Hard bound on the shared store's key count — see the eviction in cached().
export const cached = createTtlCache(256);

/**
 * `cached` for a same-origin JSON proxy: memoise the SERIALIZED body and hand
 * back a fresh `Response` around it.
 *
 * The string, not the object, is what's held on purpose. At poll volume the
 * remaining per-request cost once the backend hop is gone is re-stringifying
 * the payload (~6.6 KB on the recent-pulls feed), and that is charged once per
 * request per open tab. A `Response` cannot be reused instead — its body is a
 * one-shot stream — so the body string is the largest reusable unit.
 *
 * `cached`'s contract carries over unchanged: a loader that THROWS is not
 * memoised, so a route that must not cache a degraded answer throws inside
 * `load` and catches around this call (see /api/pull-gaps).
 */
export async function cachedJson(
  key: string,
  ttlMs: number,
  load: () => Promise<unknown>,
): Promise<Response> {
  const body = await cached(key, ttlMs, async () =>
    JSON.stringify(await load()),
  );
  return new Response(body, {
    headers: { 'content-type': 'application/json' },
  });
}

/** Test seam: module state outlives a test's fixtures — one vitest process is
 *  one module instance, so a prior test's value would be served to the next.
 *  Mirrors clearRecentPullsCache() on the backend route. */
export function clearTtlCache(): void {
  for (const store of stores) store.clear();
}
