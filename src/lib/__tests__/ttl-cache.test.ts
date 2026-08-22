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
});
