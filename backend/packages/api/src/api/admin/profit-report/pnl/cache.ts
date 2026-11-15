// One computation per query at a time, kept 5 minutes (the admin keeps a
// period 5 minutes too). A load runs ~40 read-only statements, ~45 s on prod
// under load; on 2026-11-15 reloads and range switches started new loads while
// abandoned ones kept running, so none finished. A reload or a second admin now
// waits on the same run. A failed run is not kept.
// shortcut: per process, so N backend instances compute a key up to N times.
const CACHE_MS = 5 * 60_000;
// Bound on kept results (oldest settled dropped first): every key is a real
// window, but a reader could still walk many custom ranges.
export const MAX_ENTRIES = 32;

type Entry = { at: number; body: Promise<unknown>; settled: boolean };
const cache = new Map<string, Entry>();

export function cached(
  key: string,
  build: () => Promise<unknown>,
  now = Date.now(),
): Promise<unknown> {
  // A run still going is never swept, so a later request waits on it instead
  // of starting another.
  for (const [k, v] of cache) {
    if (v.settled && now - v.at > CACHE_MS) cache.delete(k);
  }
  const hit = cache.get(key);
  if (hit) return hit.body;
  for (const [k, v] of cache) {
    if (cache.size < MAX_ENTRIES) break;
    if (v.settled) cache.delete(k);
  }
  const entry: Entry = { at: now, body: build(), settled: false };
  cache.set(key, entry);
  entry.body.then(
    () => {
      entry.settled = true;
    },
    // A failed run is not kept; only its own entry is removed.
    () => {
      if (cache.get(key) === entry) cache.delete(key);
    },
  );
  return entry.body;
}
