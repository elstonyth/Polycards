import Redis from 'ioredis';
import { userLock } from '../user-lock';

// Two userLock()s with their own clients are the 2 web instances. Against a
// real Redis only when ASSISTANT_LOCK_TEST_REDIS points at one (e.g.
// redis://localhost:6379/15 — a spare db: the test never flushes, it deletes
// its own keys); CI has none and runs just the per-process part.

describe('userLock without Redis', () => {
  it('holds one per person in this process, and lets go', async () => {
    const lock = userLock('t', 60_000, undefined);
    const release = await lock.take('u1');
    expect(release).not.toBeNull();
    expect(await lock.take('u1')).toBeNull();
    expect(await lock.take('u2')).not.toBeNull();
    await release?.();
    expect(await lock.take('u1')).not.toBeNull();
  });
});

const url = process.env.ASSISTANT_LOCK_TEST_REDIS;
(url ? describe : describe.skip)('userLock across two instances', () => {
  const clients: Redis[] = [];
  const instance = (ttlMs: number) => {
    const client = new Redis(url as string, { maxRetriesPerRequest: 1 });
    clients.push(client);
    return userLock('locktest', ttlMs, client);
  };
  const user = `u-${process.pid}-${Date.now()}`;

  afterAll(async () => {
    await clients[0]?.del(`assistant:locktest:${user}`);
    await Promise.all(clients.map((c) => c.quit()));
  });

  it('refuses the second instance while the first holds it', async () => {
    const a = instance(60_000);
    const b = instance(60_000);
    const release = await a.take(user);
    expect(release).not.toBeNull();
    expect(await b.take(user)).toBeNull();
    await release?.();
    const next = await b.take(user);
    expect(next).not.toBeNull();
    await next?.();
  });

  it('frees itself after the ttl, and a late release keeps the new holder', async () => {
    const a = instance(300);
    const b = instance(60_000);
    const c = instance(60_000);
    const late = await a.take(user);
    expect(late).not.toBeNull();
    await new Promise((r) => setTimeout(r, 450));
    const fresh = await b.take(user);
    expect(fresh).not.toBeNull();
    // a's crashed-and-back release must not delete b's lock
    await late?.();
    expect(await c.take(user)).toBeNull();
    await fresh?.();
    expect(await c.take(user)).not.toBeNull();
  });
});
