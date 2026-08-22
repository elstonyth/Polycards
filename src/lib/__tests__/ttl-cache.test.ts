import { afterEach, describe, expect, it, vi } from 'vitest';
import { cached, clearTtlCache } from '@/lib/ttl-cache';

afterEach(() => {
  clearTtlCache();
  vi.useRealTimers();
});

describe('cached', () => {
  it('serves one load per key per window', async () => {
    const load = vi.fn(async () => 'a');
    expect(await cached('k', 1000, load)).toBe('a');
    expect(await cached('k', 1000, load)).toBe('a');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('keys separately', async () => {
    const load = vi.fn(async (v: string) => v);
    await cached('one', 1000, () => load('one'));
    await cached('two', 1000, () => load('two'));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('collapses a concurrent stampede into a single load', async () => {
    const load = vi.fn(async () => 'a');
    await Promise.all([
      cached('k', 1000, load),
      cached('k', 1000, load),
      cached('k', 1000, load),
    ]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('reloads once the window expires', async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => 'a');
    await cached('k', 1000, load);
    vi.advanceTimersByTime(1001);
    await cached('k', 1000, load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not serve a rejection for the rest of the window', async () => {
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue('ok');
    await expect(cached('k', 60_000, load)).rejects.toThrow('boom');
    expect(await cached('k', 60_000, load)).toBe('ok');
  });

  it('evicts the oldest key once the store exceeds MAX_ENTRIES', async () => {
    const MAX_ENTRIES = 256;
    const load = vi.fn(async () => 'v');
    const firstKey = 'k-0';
    // Fill past the bound: firstKey plus MAX_ENTRIES + 10 more distinct keys.
    await cached(firstKey, 60_000, load);
    for (let i = 1; i <= MAX_ENTRIES + 10; i++) {
      await cached(`k-${i}`, 60_000, load);
    }
    load.mockClear();

    // The first-inserted key was evicted under pressure — its loader reruns.
    await cached(firstKey, 60_000, load);
    expect(load).toHaveBeenCalledTimes(1);

    // The most-recently-inserted key is still memoised — no rerun.
    load.mockClear();
    await cached(`k-${MAX_ENTRIES + 10}`, 60_000, load);
    expect(load).toHaveBeenCalledTimes(0);
  });
});
