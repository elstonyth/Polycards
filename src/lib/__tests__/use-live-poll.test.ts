// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import {
  renderHook,
  flush,
  setVisibility,
  presetVisibility,
} from './render-hook';
import { useCardPrice } from '../use-card-price';
import type { CardDetailData } from '../data/cards';
import { useLivePoll } from '../use-live-poll';

beforeEach(() => {
  presetVisibility('visible');
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useLivePoll', () => {
  it('fetches immediately on mount, then once per interval while visible', async () => {
    const fetchJson = vi.fn(async () => ({ n: 1 }));
    const h = renderHook(
      () =>
        useLivePoll<{ n: number }>(
          '/api/x',
          { n: 0 },
          { intervalMs: 1000, fetchJson },
        ),
      {},
    );
    expect(h.current.data).toEqual({ n: 0 });
    await flush();
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(fetchJson).toHaveBeenCalledWith('/api/x');
    expect(h.current.data).toEqual({ n: 1 });

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await flush();
    expect(fetchJson).toHaveBeenCalledTimes(2);
    h.unmount();
  });

  it('never fires while the tab is hidden, and refetches the moment it becomes visible', async () => {
    presetVisibility('hidden');
    const fetchJson = vi.fn(async () => ({ n: 1 }));
    const h = renderHook(
      () =>
        useLivePoll<{ n: number }>(
          '/api/x',
          { n: 0 },
          { intervalMs: 1000, fetchJson },
        ),
      {},
    );
    await flush();
    expect(fetchJson).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    expect(fetchJson).not.toHaveBeenCalled();

    setVisibility('visible');
    await flush();
    expect(fetchJson).toHaveBeenCalledTimes(1);
    expect(h.current.data).toEqual({ n: 1 });
    h.unmount();
  });

  it('polls nothing while the url is null', async () => {
    const fetchJson = vi.fn(async () => ({ n: 1 }));
    const h = renderHook(
      (p: { url: string | null }) =>
        useLivePoll<{ n: number }>(
          p.url,
          { n: 0 },
          { intervalMs: 1000, fetchJson },
        ),
      { url: null as string | null },
    );
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(5000);
    });
    setVisibility('hidden');
    setVisibility('visible');
    expect(fetchJson).not.toHaveBeenCalled();
    expect(h.current.data).toEqual({ n: 0 });

    // ...and starts polling as soon as one arrives.
    h.rerender({ url: '/api/x' });
    await flush();
    expect(fetchJson).toHaveBeenCalledTimes(1);
    h.unmount();
  });

  it('a resetKey change refetches at once and stays pending until that key lands', async () => {
    const fetchJson = vi.fn(async (url: string) => ({ url }));
    const h = renderHook(
      (p: { key: string }) =>
        useLivePoll<{ url: string }>(
          `/api/${p.key}`,
          { url: 'seed' },
          { intervalMs: 1000, resetKey: p.key, fetchJson },
        ),
      { key: 'a' },
    );
    await flush();
    expect(h.current).toEqual({
      data: { url: '/api/a' },
      pending: false,
      shownKey: 'a',
    });

    h.rerender({ key: 'b' });
    // The previous key's data is still what the hook holds — an adopter that
    // wants a clean slate renders `initial` while pending.
    expect(h.current.pending).toBe(true);
    expect(h.current.shownKey).toBe('a');
    expect(h.current.data).toEqual({ url: '/api/a' });

    await flush();
    expect(fetchJson).toHaveBeenCalledTimes(2);
    expect(h.current).toEqual({
      data: { url: '/api/b' },
      pending: false,
      shownKey: 'b',
    });
    h.unmount();
  });

  it('accept returning null keeps the previous data (and leaves pending set)', async () => {
    const accept = vi.fn(
      (next: unknown, _prev: { n: number }, pending: boolean) =>
        pending ? (next as { n: number }) : null,
    );
    const fetchJson = vi.fn(async () => ({ n: 9 }));
    const h = renderHook(
      (p: { key: string }) =>
        useLivePoll<{ n: number }>(
          '/api/x',
          { n: 0 },
          { intervalMs: 1000, resetKey: p.key, accept, fetchJson },
        ),
      { key: 'a' },
    );
    await flush();
    // Not pending on the first tick, so accept rejects it: seed survives.
    expect(accept).toHaveBeenCalledTimes(1);
    expect(h.current.data).toEqual({ n: 0 });
    expect(h.current.pending).toBe(false);

    // A key change makes it pending — now the same payload is accepted.
    h.rerender({ key: 'b' });
    await flush();
    expect(h.current.data).toEqual({ n: 9 });
    expect(h.current.shownKey).toBe('b');
    h.unmount();
  });

  it('a response that arrives after a newer one never writes', async () => {
    const settle: Array<(value: unknown) => void> = [];
    const fetchJson = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          settle.push(resolve);
        }),
    );
    const h = renderHook(
      () =>
        useLivePoll<string>('/api/x', 'seed', { intervalMs: 1000, fetchJson }),
      {},
    );
    // Mount tick, then a visibility refetch on top of it: two in flight.
    setVisibility('visible');
    expect(settle).toHaveLength(2);

    settle[1]!('newer');
    await flush();
    expect(h.current.data).toBe('newer');

    settle[0]!('older');
    await flush();
    expect(h.current.data).toBe('newer');
    h.unmount();
  });

  it('keeps the last good data when a fetch fails or answers null', async () => {
    const fetchJson = vi
      .fn<(url: string) => Promise<unknown>>()
      .mockResolvedValueOnce('good')
      .mockResolvedValueOnce(null) // !res.ok
      .mockRejectedValueOnce(new Error('network down'));
    const h = renderHook(
      () =>
        useLivePoll<string>('/api/x', 'seed', { intervalMs: 1000, fetchJson }),
      {},
    );
    await flush();
    expect(h.current.data).toBe('good');

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await flush();
    expect(h.current.data).toBe('good');

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await flush();
    expect(h.current.data).toBe('good');
    h.unmount();
  });
});

const cardSeed: CardDetailData = {
  handle: 'a',
  name: 'Card A',
  image: '/a.png',
  slabImage: null,
  priceMyr: 2,
  rarity: 'Rare',
  pokemonDex: null,
  spriteImage: null,
  set: 'Base',
  grade: '10',
  grader: 'PSA',
  pcSyncedAt: null,
  priceHistory: [],
};

it.each([
  {
    handle: 'a',
    name: 'Card A',
    image: '/a.png',
    slab_image: null,
    marketPriceMyr: 5,
    rarity: 'Rare',
    pokemon_dex: null,
    sprite_image: null,
    set: 'Base',
    grade: '10',
    grader: 'PSA',
    pcSyncedAt: null,
    priceHistory: [],
  },
  { ...cardSeed, priceMyr: '5' },
  { ...cardSeed, priceMyr: null },
  { ...cardSeed, priceHistory: [null] },
])(
  'card-price retains seed and last-good data across incompatible server JSON: %j',
  async (card) => {
    const fresh = { ...cardSeed, priceMyr: 8 };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ card }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ card: fresh }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ card }) });
    vi.stubGlobal('fetch', fetcher);
    const h = renderHook(() => useCardPrice('a', cardSeed), undefined);
    await flush();
    expect(h.current).toEqual(cardSeed);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(h.current).toEqual(fresh);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(h.current).toEqual(fresh);
    h.unmount();
    vi.unstubAllGlobals();
  },
);

it('card-price switches to the new seed immediately and ignores a late previous-handle response', async () => {
  const pending: ((body: unknown) => void)[] = [];
  const fetcher = vi.fn<(url: string) => Promise<unknown>>(
    () =>
      new Promise((resolve) => {
        pending.push((body) => resolve({ ok: true, json: async () => body }));
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  const props = { handle: 'a', initial: cardSeed };
  const h = renderHook(
    () => useCardPrice(props.handle, props.initial),
    undefined,
  );
  expect(h.current).toEqual(cardSeed);
  props.handle = 'b';
  props.initial = { ...cardSeed, handle: 'b', priceMyr: 3 };
  h.rerender();
  expect(h.current).toEqual(props.initial);
  await act(async () => {
    pending[1]!({ card: { ...props.initial, priceMyr: 4 } });
  });
  expect(h.current?.priceMyr).toBe(4);
  await act(async () => {
    pending[0]!({ card: { ...cardSeed, priceMyr: 99 } });
  });
  expect(h.current).toEqual({ ...props.initial, priceMyr: 4 });
  expect(fetcher.mock.calls.map((args) => args[0])).toEqual([
    '/api/cards/a',
    '/api/cards/b',
  ]);
  h.unmount();
  vi.unstubAllGlobals();
});
