import type Redis from 'ioredis';
import { connectRedis, throttledWarn } from './rate-limit';

// "Online now" on the admin Dashboard (2026-10-15): the storefront pings
// POST /store/presence while a signed-in tab is visible (on load, every 2
// minutes, and when the tab comes back), and a player is online while their
// latest ping is under 5 minutes old. One sorted set, member = customer id,
// score = the latest ping in ms, so a player is one member however many tabs
// they have open. Redis is what every backend replica shares; without
// REDIS_URL (local dev, unit tests) it is a per-process map.

/** A player is online while their latest ping is this recent. */
export const ONLINE_WINDOW_MS = 5 * 60_000;
// Pings older than this are dropped as new ones arrive.
const RETAIN_MS = 24 * 60 * 60_000;
const KEY = 'presence:customers';

export interface PresenceStore {
  touch(customerId: string, nowMs: number): Promise<void>;
  /** Everyone whose latest ping is at or after `sinceMs`. */
  seenSince(sinceMs: number): Promise<string[]>;
}

export class InMemoryPresenceStore implements PresenceStore {
  private readonly seen = new Map<string, number>();

  async touch(customerId: string, nowMs: number): Promise<void> {
    this.seen.set(customerId, nowMs);
    for (const [id, at] of this.seen) {
      if (at < nowMs - RETAIN_MS) this.seen.delete(id);
    }
  }

  async seenSince(sinceMs: number): Promise<string[]> {
    return [...this.seen].filter(([, at]) => at >= sinceMs).map(([id]) => id);
  }

  size(): number {
    return this.seen.size;
  }
}

class RedisPresenceStore implements PresenceStore {
  constructor(private readonly client: Redis) {}

  async touch(customerId: string, nowMs: number): Promise<void> {
    await this.client
      .multi()
      .zadd(KEY, nowMs, customerId)
      .zremrangebyscore(KEY, '-inf', nowMs - RETAIN_MS)
      .pexpire(KEY, RETAIN_MS)
      .exec();
  }

  async seenSince(sinceMs: number): Promise<string[]> {
    return this.client.zrangebyscore(KEY, sinceMs, '+inf');
  }
}

let shared: PresenceStore | undefined;

/** The process's presence store, connected on first use. */
export function presenceStore(): PresenceStore {
  if (!shared) {
    const client = connectRedis('presence', throttledWarn(60_000));
    shared = client
      ? new RedisPresenceStore(client)
      : new InMemoryPresenceStore();
  }
  return shared;
}
