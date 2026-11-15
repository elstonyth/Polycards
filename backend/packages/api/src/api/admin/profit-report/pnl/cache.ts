import type { ICacheService } from '@medusajs/framework/types';

// One computation per query at a time, kept 5 minutes (the admin keeps a
// period 5 minutes too). A load runs ~44 read-only statements, ~20-26 s on
// prod; on 2026-11-15 reloads and range switches started new loads while
// abandoned ones kept running, so none finished. A reload or a second admin now
// waits on the same run.
//
// Results live in the cache module (Redis in prod, in-memory elsewhere), not
// this process: prod runs two backend instances, and a per-process cache
// missed on the other one (logs 2026-11-15: the same month computed cold on
// both within a minute). A failed run is not kept.
// shortcut: the in-flight share is per process, so two instances asked for the
// same cold key in the same seconds both compute it; add a Redis lock if that
// starts to matter.
export const CACHE_S = 5 * 60;
// A period that ended before now (last month, yesterday, a past custom range)
// only moves by late supplier costs and today's card prices (prize and unsold
// free cards), so it is kept 6 hours (owner 2026-11-15).
export const CLOSED_CACHE_S = 6 * 60 * 60;
const PREFIX = 'pnl-report:';

export type ReportCache = Pick<ICacheService, 'get' | 'set'>;

const inflight = new Map<string, Promise<unknown>>();

export function cached<T>(
  store: ReportCache,
  key: string,
  build: () => Promise<T>,
  ttlS = CACHE_S,
): Promise<T> {
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const run = (async () => {
    // A cache outage (Valkey timeout) computes instead of failing the page.
    const hit = await store.get<T>(PREFIX + key).catch(() => null);
    if (hit !== null && hit !== undefined) return hit;
    const body = await build();
    await store.set(PREFIX + key, body, ttlS).catch(() => undefined);
    return body;
  })().finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}
