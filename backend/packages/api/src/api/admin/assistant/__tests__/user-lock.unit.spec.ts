import Redis from 'ioredis';
import { userLock } from '../user-lock';

// Two userLock()s with their own clients are the 2 web instances. Against a
// real Redis only when ASSISTANT_LOCK_TEST_REDIS points at one (e.g.
// redis://localhost:6379/15 — a spare db: the test never flushes, it deletes
// its own keys); CI has none and runs just the per-process part.

describe('userLock without Redis', () => {
  it('holds one per person in this process, and lets go', async () => {
    const lock = userLock('t', 60_000, null);
    const release = await lock.take('u1');
    expect(release).not.toBeNull();
    expect(await lock.take('u1')).toBeNull();
    expect(await lock.take('u2')).not.toBeNull();
    await release?.();
    expect(await lock.take('u1')).not.toBeNull();
  });

  it('frees a hold stuck past its ttl (a stalled upload)', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const lock = userLock('t', 1_000, null);
      const stuck = await lock.take('u1');
      expect(stuck).not.toBeNull();
      expect(await lock.take('u1')).toBeNull();
      jest.advanceTimersByTime(1_001);
      const next = await lock.take('u1');
      expect(next).not.toBeNull();
      // the stuck one finishing late must not free the new holder
      await stuck?.();
      expect(await lock.take('u1')).toBeNull();
      await next?.();
    } finally {
      jest.useRealTimers();
    }
  });
});

// A fake Redis: SET NX PX and the token-checked release, in memory, so CI
// covers the cross-instance branch without a server.
function fakeRedis() {
  const keys = new Map<string, string>();
  let down = false;
  const client = {
    keys,
    goDown: () => (down = true),
    set: jest.fn(async (key: string, token: string) => {
      if (down) throw new Error('Connection is closed.');
      if (keys.has(key)) return null;
      keys.set(key, token);
      return 'OK';
    }),
    eval: jest.fn(
      async (_s: string, _n: number, key: string, token: string) => {
        if (down) throw new Error('Connection is closed.');
        if (keys.get(key) !== token) return 0;
        keys.delete(key);
        return 1;
      },
    ),
    once: jest.fn(),
  };
  return client;
}

describe('userLock with a Redis', () => {
  it('lets go locally when another instance holds it', async () => {
    const redis = fakeRedis();
    redis.keys.set('assistant:t:u1', 'other-instance');
    const lock = userLock('t', 60_000, redis as never);
    expect(await lock.take('u1')).toBeNull();
    redis.keys.clear(); // the other instance finished
    const release = await lock.take('u1');
    expect(release).not.toBeNull();
    await release?.();
  });

  it('releases only its own token', async () => {
    const redis = fakeRedis();
    const lock = userLock('t', 60_000, redis as never);
    const release = await lock.take('u1');
    const token = redis.set.mock.calls[0][1];
    redis.keys.set('assistant:t:u1', 'someone-else'); // expired and retaken
    await release?.();
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      'assistant:t:u1',
      token,
    );
    expect(redis.keys.get('assistant:t:u1')).toBe('someone-else');
  });

  it('falls back to this process when Redis fails, and retries a lost release', async () => {
    const redis = fakeRedis();
    redis.goDown();
    const lock = userLock('t', 60_000, redis as never);
    const release = await lock.take('u1');
    expect(release).not.toBeNull(); // still one at a time here
    expect(await lock.take('u1')).toBeNull();
    await release?.();
    expect(redis.once).toHaveBeenCalledWith('ready', expect.any(Function));
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
