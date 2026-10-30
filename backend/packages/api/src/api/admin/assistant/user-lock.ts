import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';
import { connectRedis, throttledWarn } from '../../utils/rate-limit';

// One thing at a time per staff member (an answer, a read-aloud), so parallel
// requests cannot all pass the daily cap check before any of them has saved
// its cost. Redis holds the lock across the 2 web instances; without
// REDIS_URL (dev, tests) or while Redis fails, only the per-process map does.

const RELEASE = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) end return 0`;

/** A named per-person lock. ttlMs must outlast the work it guards, so a
 *  crashed instance's lock frees itself and a live one never expires early;
 *  the per-process hold expires the same way, so work stuck past it (a
 *  stalled upload) can't lock the person out of this instance for good.
 *  client is for tests (null: no Redis); by default it connects to
 *  REDIS_URL at load (a client still connecting refuses its first command). */
export function userLock(
  name: string,
  ttlMs: number,
  client: Redis | null = connectRedis(
    `assistant-${name}`,
    throttledWarn(60_000),
  ) ?? null,
): {
  /** The person's lock: its release, or null while it is held elsewhere. */
  take(userId: string): Promise<(() => Promise<void>) | null>;
} {
  const held = new Map<string, { token: string; until: number }>();
  const warn = throttledWarn(60_000);
  return {
    async take(userId) {
      const holder = held.get(userId);
      if (holder && holder.until > Date.now()) return null;
      const key = `assistant:${name}:${userId}`;
      const token = randomUUID();
      held.set(userId, { token, until: Date.now() + ttlMs });
      const letGo = () => {
        if (held.get(userId)?.token === token) held.delete(userId);
      };
      try {
        const ok = (await client?.set(key, token, 'PX', ttlMs, 'NX')) === 'OK';
        if (client && !ok) {
          letGo();
          return null;
        }
      } catch (err) {
        warn(
          `assistant ${name} lock: redis failed; per-process lock only`,
          err,
        );
      }
      return async () => {
        letGo();
        // Only this holder's own token: an expired lock may be someone else's.
        // Tried even when the SET reply was lost: it may still have landed.
        await client?.eval(RELEASE, 1, key, token).catch((err) => {
          warn(`assistant ${name} lock: release failed`, err);
          // once more when Redis is back, rather than leave the person
          // "busy" until the lock expires
          client.once('ready', () => {
            client.eval(RELEASE, 1, key, token).catch(() => undefined);
          });
        });
      };
    },
  };
}
