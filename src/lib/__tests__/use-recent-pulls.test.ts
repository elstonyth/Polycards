// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createElement, act, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useLiveRecentPulls } from '../use-recent-pulls';
import type { RecentFeed, RecentPull } from '@/lib/data/packs';

// Same createRoot + act harness as use-pack-detail-poll.test.ts (no hook
// testing library in the repo). The hook's rules under test are all
// ACROSS-render behaviour — a changing tier prop, an empty response for the
// scope already on screen, the pending flag — so a pure-logic extraction
// could not observe them.
function renderHook<P, T>(useHook: (props: P) => T, initial: P) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const box: { current: T } = { current: undefined as unknown as T };
  let root!: Root;
  function Probe({ props }: { props: P }) {
    const result = useHook(props);
    useLayoutEffect(() => {
      box.current = result;
    });
    return null;
  }
  act(() => {
    root = createRoot(container);
    root.render(createElement(Probe, { props: initial }));
  });
  return {
    get current() {
      return box.current;
    },
    rerender: (props: P) => {
      act(() => {
        root.render(createElement(Probe, { props }));
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

Object.defineProperty(document, 'visibilityState', {
  configurable: true,
  get: () => 'visible',
});

const pull = (
  id: string,
  rarity: RecentPull['rarity'] = 'Common',
): RecentPull => ({
  id,
  handle: `card-${id}`,
  name: `Card ${id}`,
  image: '/c.png',
  slabImage: null,
  profileHandle: null,
  value: 'RM 1.00',
  rarity,
  packName: 'Bronze Pack',
  packIcon: '/p.webp',
  who: 'PW',
  avatar: null,
  frame: null,
  rolledAt: '2026-09-02T13:38:44.000Z',
  agoLabel: 'just now',
});

const seed: RecentFeed = {
  pulls: [pull('a'), pull('b')],
  drought: { Immortal: 3 },
};

const fetchMock = vi.fn();
const respond = (body: unknown, ok = true) =>
  fetchMock.mockResolvedValueOnce({ ok, json: async () => body });
const flush = () => act(async () => {});

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useLiveRecentPulls', () => {
  it('seeds from the server snapshot, then swaps in the live feed', async () => {
    respond({
      pulls: [pull('c'), pull('a'), pull('b')],
      drought: { Immortal: 0 },
    });
    const h = renderHook(
      (p: { rarity: 'Immortal' | 'Legendary' | null }) =>
        useLiveRecentPulls(seed, 'bronze-pack', p.rarity),
      { rarity: null as 'Immortal' | 'Legendary' | null },
    );
    expect(h.current.pulls.map((p) => p.id)).toEqual(['a', 'b']);
    expect(h.current.pending).toBe(false);
    await flush();
    expect(h.current.pulls.map((p) => p.id)).toEqual(['c', 'a', 'b']);
    expect(h.current.drought).toEqual({ Immortal: 0 });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/api/recent-pulls?pack_id=bronze-pack',
    );
    h.unmount();
  });

  it('a tier switch refetches at once, keeps the old rows as pending until the new scope lands, then re-keys', async () => {
    respond(seed);
    const h = renderHook(
      (p: { rarity: 'Immortal' | 'Legendary' | null }) =>
        useLiveRecentPulls(seed, 'bronze-pack', p.rarity),
      { rarity: null as 'Immortal' | 'Legendary' | null },
    );
    await flush();
    const before = h.current.shownScope;

    respond({ pulls: [pull('imm', 'Immortal')], drought: { Immortal: 0 } });
    h.rerender({ rarity: 'Immortal' });
    // Old rows stay on screen, flagged pending, scope unchanged.
    expect(h.current.pending).toBe(true);
    expect(h.current.shownScope).toBe(before);
    expect(h.current.pulls.map((p) => p.id)).toEqual(['a', 'b']);
    expect(fetchMock.mock.calls[1]![0]).toBe(
      '/api/recent-pulls?pack_id=bronze-pack&rarity=Immortal',
    );

    await flush();
    expect(h.current.pending).toBe(false);
    expect(h.current.shownScope).not.toBe(before);
    expect(h.current.pulls.map((p) => p.id)).toEqual(['imm']);
    h.unmount();
  });

  it('ignores an empty response for the scope already on screen (a blip must not blank a live feed)…', async () => {
    respond(seed);
    const h = renderHook(
      () => useLiveRecentPulls(seed, 'bronze-pack', null),
      {},
    );
    await flush();
    respond({ pulls: [], drought: {} });
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    await flush();
    expect(h.current.pulls.map((p) => p.id)).toEqual(['a', 'b']);
    expect(h.current.drought).toEqual({ Immortal: 3 });
    h.unmount();
  });

  it("…but an empty response for a NEW scope is that scope's honest empty state", async () => {
    respond(seed);
    const h = renderHook(
      (p: { rarity: 'Immortal' | 'Legendary' | null }) =>
        useLiveRecentPulls(seed, 'bronze-pack', p.rarity),
      { rarity: null as 'Immortal' | 'Legendary' | null },
    );
    await flush();
    respond({ pulls: [], drought: { Immortal: 3 } });
    h.rerender({ rarity: 'Legendary' });
    await flush();
    expect(h.current.pulls).toEqual([]);
    expect(h.current.pending).toBe(false);
    h.unmount();
  });

  it('keeps the current set on a failed poll', async () => {
    respond(seed);
    const h = renderHook(() => useLiveRecentPulls(seed, undefined, null), {});
    await flush();
    respond(null, false);
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    await flush();
    expect(h.current.pulls.map((p) => p.id)).toEqual(['a', 'b']);
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/recent-pulls');
    h.unmount();
  });
});
