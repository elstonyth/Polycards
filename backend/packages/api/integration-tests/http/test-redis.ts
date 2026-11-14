// The HTTP harness's Redis helpers, kept apart from utils.ts so a suite that
// only needs Redis does not load the packs module with them. utils.ts
// re-exports both, so existing imports keep working.
import Redis from 'ioredis';

/**
 * One redis for the whole HTTP harness: CI exports REDIS_URL; locally the
 * pokenic-redis container answers on the default. Suites that assert on the
 * app-under-test's rl:* keys must ALSO put this into their runner env — the
 * limiter reads process.env.REDIS_URL at boot and silently falls back to its
 * in-memory store when unset, leaving this probe inspecting an empty redis.
 */
export const TEST_REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

/**
 * Connects to the test Redis or THROWS — deliberately no skip: the rate
 * limiter silently fails over to its in-memory store, so a suite that skipped
 * this probe would stay green even with the Redis path broken. `purpose` says
 * what the suite needs Redis for, verbatim, in the failure message.
 */
export async function connectTestRedisOrFail(purpose: string): Promise<Redis> {
  const url = TEST_REDIS_URL;
  const redis = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 2_000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  redis.on('error', () => {
    /* assertions surface failures; avoid unhandled 'error' events */
  });
  try {
    await redis.connect();
  } catch (err) {
    throw new Error(
      `Redis unreachable at ${url} — ${purpose}. Start it: docker start pokenic-redis. (${err})`,
    );
  }
  return redis;
}
