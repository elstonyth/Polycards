/**
 * Cross-adopter contract for src/lib/ttl-cache.ts's `cached()`: every adopter
 * MUST let a fetch/shape failure THROW out of its loader so `cached` evicts
 * instead of memoising the degradation for the rest of the TTL window — a
 * genuinely empty/off backend state is the one exception, and THAT is
 * allowed to cache. See ttl-cache.ts's header for the full contract.
 *
 * Anyone adding a new `cached()` adopter should add a case here pinning
 * which failures throw (evict) vs which values are legitimately cacheable.
 *
 * Every adopter reads through the `Store` port, so each seeds `memoryStore`
 * via the shared shim and the real schema/parse path runs. avatar-frames.ts
 * imports 'server-only' (throws outside an RSC) at module load — stub it,
 * mirroring profiles.test.ts.
 *
 * A port-backed adopter expresses "this call failed" as a NON-2xx rather than
 * a rejected promise: the HTTP adapter catches the SDK's rejection and turns
 * it into a `Failure`, so a 502 is the same event this contract cares about —
 * a failure that must never be memoised. Response QUEUES stand in for
 * `mockResolvedValueOnce` chains, and `memoryStore`'s recorded `requests` for
 * the fetch call count.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { storeShim, backend } from '@/lib/__tests__/store-shim';
import type { MemoryResponse } from '@/lib/store-memory';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/store', () => ({ store: storeShim }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { getPackCategories, getPullGaps } from '@/lib/data/packs';
import { getAvatarFrames } from '@/lib/data/avatar-frames';
import { getLeaderboard } from '@/lib/data/leaderboard';
import { getChallenge } from '@/lib/data/challenge';
import { cachedJson, clearTtlCache } from '@/lib/ttl-cache';

/** One route answering a queued response per call — the port equivalent of a
 *  `mockResolvedValueOnce` chain. An exhausted queue answers 502, so a test
 *  that re-fetches when it should not fails on its own assertion. */
const queued = (route: string) => {
  const queue: MemoryResponse[] = [];
  const mem = backend({
    [route]: () => queue.shift() ?? { status: 502, body: {} },
  });
  return { push: (r: MemoryResponse) => queue.push(r), mem };
};

beforeEach(() => {
  // Every adopter below shares the one module-level TTL store — without
  // this, the first case's memo would be served to every later one.
  clearTtlCache();
});

describe('getPackCategories cache contract', () => {
  it('a failed fetch is NOT cached: returns [] and the next call re-fetches', async () => {
    const catalog = queued('GET /store/packs');
    catalog.push({ status: 502, body: { message: 'backend down' } });
    expect(await getPackCategories()).toEqual([
      {
        id: 'pokemon',
        tab: 'Pokémon',
        heading: 'Pokémon Packs',
        icon: '/pack-index-icons/pokemon.webp',
        packs: [],
      },
    ]);

    catalog.push({ body: { packs: [] } });
    await getPackCategories();
    expect(catalog.mem.requests).toHaveLength(2);
  });

  it('a malformed 200 (non-array packs) is NOT cached: degrades to empty categories and the next call re-fetches', async () => {
    // This case FAILS before plan 117 step 4 — loadPackCategories used to
    // silently coerce a non-array `packs` to [] INSIDE the memo, so the
    // degraded empty catalog would cache successfully for the full 30s TTL.
    // PacksPageSchema's droppableArray is what keeps that true through the
    // port: `listOf` would have coerced it right back to [].
    const catalog = queued('GET /store/packs');
    catalog.push({ body: { packs: 'garbage' } });
    const first = await getPackCategories();
    expect(first.flatMap((c) => c.packs)).toEqual([]);

    catalog.push({ body: { packs: [] } });
    await getPackCategories();
    expect(catalog.mem.requests).toHaveLength(2);
  });
});

describe('getAvatarFrames cache contract', () => {
  it('a schema-invalid body is NOT cached: degrades to {} and the next call re-fetches', async () => {
    const frames = queued('GET /store/avatar-frames');
    // frames is a required field — omitting it fails AvatarFramesSchema.
    frames.push({ body: {} });
    expect(await getAvatarFrames()).toEqual({});

    frames.push({ body: { frames: { '1': '/frame-1.webp' } } });
    await getAvatarFrames();
    expect(frames.mem.requests).toHaveLength(2);
  });
});

describe('getLeaderboard cache contract', () => {
  it('non-array entries is NOT cached: degrades to [] and the next call re-fetches', async () => {
    const board = queued('GET /store/leaderboard');
    board.push({ body: { entries: 'garbage' } });
    expect(await getLeaderboard('weekly')).toEqual([]);

    board.push({ body: { entries: [] } });
    await getLeaderboard('weekly');
    expect(board.mem.requests).toHaveLength(2);
  });

  it('a legitimately empty board IS cached: the next call does NOT re-fetch', async () => {
    const board = queued('GET /store/leaderboard');
    board.push({ body: { entries: [] } });
    expect(await getLeaderboard('weekly')).toEqual([]);

    await getLeaderboard('weekly');
    expect(board.mem.requests).toHaveLength(1);
  });
});

describe('getChallenge cache contract', () => {
  // Minimal-but-valid document: active:false with the schema's other
  // required fields (settings, stages, cards) present but empty.
  const off = {
    active: false,
    settings: { timezone: 'Asia/Kuala_Lumpur', resetDay: 1, resetHour: 0 },
    stages: [],
    cards: {},
  };

  it('a schema-invalid body is NOT cached: returns null and the next call re-fetches', async () => {
    const challenge = queued('GET /store/challenge');
    // Missing active/settings/stages/cards entirely fails ChallengeSchema.
    challenge.push({ body: {} });
    expect(await getChallenge()).toBeNull();

    challenge.push({ body: off });
    await getChallenge();
    expect(challenge.mem.requests).toHaveLength(2);
  });

  it('challenge genuinely off (active:false) IS cached: the next call does NOT re-fetch', async () => {
    const challenge = queued('GET /store/challenge');
    challenge.push({ body: off });
    expect(await getChallenge()).toBeNull();

    // A re-fetch here would drain the queue to its 502 fallback; assert on the
    // recorded request count, which says it outright.
    await getChallenge();
    expect(challenge.mem.requests).toHaveLength(1);
  });
});

describe('cachedJson cache contract', () => {
  // The JSON-proxy wrapper (both feed routes) inherits `cached`'s rule: it is
  // the LOADER's throw that keeps a degradation out of the memo. /api/pull-gaps
  // is the shape that depends on it — getPullGaps swallows a backend failure
  // into null, so the route throws on that null rather than memoising
  // "unavailable" for every viewer for the rest of the window.
  const gapsBody = {
    rarity: 'Immortal',
    pct: 1.1,
    expected: 91,
    avg: 60.5,
    last20: 86,
    current: 27,
    hits: [],
  };
  const proxy = () =>
    cachedJson('gaps', 60_000, async () => {
      const gaps = await getPullGaps('Immortal');
      if (!gaps) throw new Error('pull gaps unavailable');
      return gaps;
    });

  it('a null read throws out of the loader and is NOT cached: the next call re-fetches', async () => {
    const gaps = queued('GET /store/pulls/gaps');
    gaps.push({ body: { rarity: 'Immortal', hits: 'nope' } }); // fails the schema
    await expect(proxy()).rejects.toThrow('pull gaps unavailable');

    gaps.push({ body: gapsBody });
    const ok = await proxy();
    expect(ok.headers.get('content-type')).toBe('application/json');
    expect((await ok.json()).current).toBe(27);
    expect(gaps.mem.requests).toHaveLength(2);
  });

  it('a good body IS cached: the serialized body is reused and the next call does NOT re-fetch', async () => {
    const gaps = queued('GET /store/pulls/gaps');
    gaps.push({ body: gapsBody });
    expect((await (await proxy()).json()).current).toBe(27);

    // A second Response over the SAME memoised body — a re-fetch would drain
    // the queue to its 502 fallback and throw.
    expect((await (await proxy()).json()).current).toBe(27);
    expect(gaps.mem.requests).toHaveLength(1);
  });
});
