import { cached } from '../cache';

describe('P&L report cache', () => {
  it('shares one run between concurrent requests for the same query', async () => {
    let runs = 0;
    const build = async () => {
      runs++;
      return { n: runs };
    };
    const [a, b] = await Promise.all([
      cached('k1', build, 1_000),
      cached('k1', build, 1_001),
    ]);
    expect(runs).toBe(1);
    expect(a).toBe(b);
  });

  it('keeps a result 5 minutes, then runs again', async () => {
    let runs = 0;
    const build = async () => ++runs;
    await cached('k2', build, 0);
    await cached('k2', build, 5 * 60_000);
    expect(runs).toBe(1);
    await cached('k2', build, 5 * 60_000 + 1);
    expect(runs).toBe(2);
  });

  it('does not keep a failed run', async () => {
    await expect(
      cached(
        'k3',
        async () => {
          throw new Error('db down');
        },
        0,
      ),
    ).rejects.toThrow('db down');
    await expect(cached('k3', async () => 'ok', 1)).resolves.toBe('ok');
  });
});
