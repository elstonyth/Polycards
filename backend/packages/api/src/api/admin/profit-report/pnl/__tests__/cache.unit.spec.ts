import {
  cached,
  CACHE_S,
  CLOSED_CACHE_S,
  type ReportCache,
} from '../cache';

/** The cache module's get/set, in memory; `ttls` records what set was given. */
const fakeStore = () => {
  const data = new Map<string, unknown>();
  const ttls: number[] = [];
  const store = {
    get: async (k: string) => (data.has(k) ? data.get(k) : null),
    set: async (k: string, v: unknown, ttl?: number) => {
      data.set(k, v);
      ttls.push(ttl ?? -1);
    },
  } as unknown as ReportCache;
  return { store, data, ttls };
};

describe('P&L report cache', () => {
  it('shares one run between concurrent requests for the same query', async () => {
    const { store } = fakeStore();
    let runs = 0;
    const build = async () => ({ n: ++runs });
    const [a, b] = await Promise.all([
      cached(store, 'k1', build),
      cached(store, 'k1', build),
    ]);
    expect(runs).toBe(1);
    expect(a).toBe(b);
  });

  it('serves a settled result from the shared store for 5 minutes', async () => {
    const { store, ttls } = fakeStore();
    let runs = 0;
    const build = async () => ++runs;
    await cached(store, 'k2', build);
    // A later request, or the other backend instance, reads the store.
    await expect(cached(store, 'k2', build)).resolves.toBe(1);
    expect(runs).toBe(1);
    expect(ttls).toEqual([CACHE_S]);
    expect(CACHE_S).toBe(300);
  });

  it('keeps a closed period as long as it is told', async () => {
    const { store, ttls } = fakeStore();
    await cached(store, 'k5', async () => 1, CLOSED_CACHE_S);
    expect(ttls).toEqual([6 * 60 * 60]);
  });

  it('does not keep a failed run', async () => {
    const { store, data } = fakeStore();
    await expect(
      cached(store, 'k3', async () => {
        throw new Error('db down');
      }),
    ).rejects.toThrow('db down');
    expect(data.size).toBe(0);
    await expect(cached(store, 'k3', async () => 'ok')).resolves.toBe('ok');
  });

  it('computes anyway when the cache itself is down', async () => {
    const down = {
      get: async () => {
        throw new Error('valkey timeout');
      },
      set: async () => {
        throw new Error('valkey timeout');
      },
    } as unknown as ReportCache;
    await expect(cached(down, 'k4', async () => 'fresh')).resolves.toBe(
      'fresh',
    );
  });
});
