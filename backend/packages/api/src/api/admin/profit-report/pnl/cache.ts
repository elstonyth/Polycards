// One computation per query at a time, kept 5 minutes (the admin keeps a
// period 5 minutes too). A load runs ~40 read-only statements, ~45 s on prod
// under load; on 2026-11-15 reloads and range switches started new loads while
// abandoned ones kept running, so none finished. A reload or a second admin now
// waits on the same run. A failed run is not kept.
// shortcut: per process, so N backend instances compute a key up to N times.
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; body: Promise<unknown> }>();

export function cached(
  key: string,
  build: () => Promise<unknown>,
  now = Date.now(),
): Promise<unknown> {
  for (const [k, v] of cache) if (now - v.at > CACHE_MS) cache.delete(k);
  const hit = cache.get(key);
  if (hit) return hit.body;
  const body = build();
  cache.set(key, { at: now, body });
  body.catch(() => cache.delete(key));
  return body;
}
