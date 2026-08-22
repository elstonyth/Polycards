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
 * sdk + logger are mocked; the real schema/parse path runs for each adopter,
 * mirroring packs-price.test.ts's mock wiring. avatar-frames.ts imports
 * 'server-only' (throws outside an RSC) at module load — stub it, mirroring
 * profiles.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('server-only', () => ({}));

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@/lib/medusa', () => ({ sdk: { client: { fetch: fetchMock } } }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { getPackCategories } from '@/lib/data/packs';
import { getAvatarFrames } from '@/lib/data/avatar-frames';
import { getLeaderboard } from '@/lib/data/leaderboard';
import { getChallenge } from '@/lib/data/challenge';
import { clearTtlCache } from '@/lib/ttl-cache';

beforeEach(() => {
  fetchMock.mockReset();
  // Every adopter below shares the one module-level TTL store — without
  // this, the first case's memo would be served to every later one.
  clearTtlCache();
});

describe('getPackCategories cache contract', () => {
  it('a rejected fetch is NOT cached: returns [] and the next call re-fetches', async () => {
    fetchMock.mockRejectedValueOnce(new Error('backend down'));
    expect(await getPackCategories()).toEqual([
      {
        id: 'pokemon',
        tab: 'Pokémon',
        heading: 'Pokémon Packs',
        icon: '/pack-index-icons/pokemon.webp',
        packs: [],
      },
    ]);

    fetchMock.mockResolvedValueOnce({ packs: [] });
    await getPackCategories();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a malformed 200 (non-array packs) is NOT cached: degrades to empty categories and the next call re-fetches', async () => {
    // This case FAILS before plan 117 step 4 — loadPackCategories used to
    // silently coerce a non-array `packs` to [] INSIDE the memo, so the
    // degraded empty catalog would cache successfully for the full 30s TTL.
    fetchMock.mockResolvedValueOnce({ packs: 'garbage' });
    const first = await getPackCategories();
    expect(first.flatMap((c) => c.packs)).toEqual([]);

    fetchMock.mockResolvedValueOnce({ packs: [] });
    await getPackCategories();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('getAvatarFrames cache contract', () => {
  it('a schema-invalid body is NOT cached: degrades to {} and the next call re-fetches', async () => {
    // frames is a required field — omitting it fails AvatarFramesSchema.
    fetchMock.mockResolvedValueOnce({});
    expect(await getAvatarFrames()).toEqual({});

    fetchMock.mockResolvedValueOnce({ frames: { '1': '/frame-1.webp' } });
    await getAvatarFrames();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('getLeaderboard cache contract', () => {
  it('non-array entries is NOT cached: degrades to [] and the next call re-fetches', async () => {
    fetchMock.mockResolvedValueOnce({ entries: 'garbage' });
    expect(await getLeaderboard('weekly')).toEqual([]);

    fetchMock.mockResolvedValueOnce({ entries: [] });
    await getLeaderboard('weekly');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a legitimately empty board IS cached: the next call does NOT re-fetch', async () => {
    fetchMock.mockResolvedValueOnce({ entries: [] });
    expect(await getLeaderboard('weekly')).toEqual([]);

    // No second mock queued — a re-fetch here would throw on the empty
    // queue (vitest's default mock resolves undefined, not an error, so
    // assert on the call count instead of relying on that failure mode).
    await getLeaderboard('weekly');
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    // Missing active/settings/stages/cards entirely fails ChallengeSchema.
    fetchMock.mockResolvedValueOnce({});
    expect(await getChallenge()).toBeNull();

    fetchMock.mockResolvedValueOnce(off);
    await getChallenge();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('challenge genuinely off (active:false) IS cached: the next call does NOT re-fetch', async () => {
    fetchMock.mockResolvedValueOnce(off);
    expect(await getChallenge()).toBeNull();

    await getChallenge();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
