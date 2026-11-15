import { cached, MAX_ENTRIES } from '../cache';

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

  it('never sweeps a run still going, so a later request waits on it', async () => {
    let runs = 0;
    let finish: (v: unknown) => void = () => {};
    const build = () => {
      runs++;
      return new Promise((r) => {
        finish = r;
      });
    };
    const first = cached('k4', build, 0);
    const later = cached('k4', build, 10 * 60_000);
    expect(later).toBe(first);
    expect(runs).toBe(1);
    finish('done');
    await expect(later).resolves.toBe('done');
  });

  it(`keeps at most ${MAX_ENTRIES} results, dropping the oldest settled first`, async () => {
    for (let i = 0; i < MAX_ENTRIES; i++)
      await cached(`b${i}`, async () => i, 1);
    await cached('b-new', async () => 'new', 2);
    let rebuilt = false;
    await cached(
      'b0',
      async () => {
        rebuilt = true;
        return 0;
      },
      3,
    );
    expect(rebuilt).toBe(true);
  });
});
