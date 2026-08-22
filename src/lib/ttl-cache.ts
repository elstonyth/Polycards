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
//   this storefront memo     30s (catalog, board) / 60s (avatar frames)
//   home route cache         15s (src/app/page.tsx revalidate)
//   getPackChase             60s (unstable_cache, no tags)
// ⇒ an admin pack edit can take ~60s to reach /slots, ~75s to reach /,
//   ~105s to reach a home chase card. Admin busts clear ONLY the writing
//   backend instance's Maps; the other instance rolls over on TTL.

type Entry = { expires: number; value: Promise<unknown> };

const store = new Map<string, Entry>();

// Hard bound on the store's key count — see the eviction check in cached().
const MAX_ENTRIES = 256;

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
export function cached<T>(
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.expires > Date.now()) return hit.value as Promise<T>;

  const value = load();
  store.set(key, { expires: Date.now() + ttlMs, value });
  // Hard bound: keys can be attacker-influenced (recent-pulls' pack_id), and
  // expired entries are otherwise never removed. Map iterates in insertion
  // order, so this evicts oldest-inserted first — not LRU, but the legit key
  // population is tiny (catalog + a few fixed keys), so anything evicted
  // under pressure is an attacker key or long-expired.
  if (store.size > MAX_ENTRIES) {
    store.delete(store.keys().next().value as string);
  }
  void value.catch(() => {
    // Only evict our own entry — a later window may have replaced it already.
    if (store.get(key)?.value === value) store.delete(key);
  });
  return value;
}

/** Test seam: module state outlives a test's fixtures — one vitest process is
 *  one module instance, so a prior test's value would be served to the next.
 *  Mirrors clearRecentPullsCache() on the backend route. */
export function clearTtlCache(): void {
  store.clear();
}
