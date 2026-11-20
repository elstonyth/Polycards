import { beforeEach, describe, expect, it, vi } from 'vitest';

// The homepage projection carries each pack's pull odds so the stage can print
// them on a pack's 3D back. Owner rule (2026-11-20): the value comes ONLY from
// the staff-entered odds field (`pull_odds`, the old code's odds), never from the
// pool, its counts or values, and with nothing entered it is null.
import { storeShim, backend } from '@/lib/__tests__/store-shim';

vi.mock('@/lib/store', () => ({ store: storeShim }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('next/cache', () => ({ unstable_cache: <F>(fn: F) => fn }));

import { getPackDetail, getPackHighlights } from '@/lib/data/packs';
import { pullOddsRows } from '@/lib/packs-format';
import { packBackDetails } from '@/components/pack-3d/pack-back-details';
import { clearTtlCache } from '@/lib/ttl-cache';
import type { ResolvedPack } from '@/lib/packs-data';

beforeEach(() => clearTtlCache());

const card = (handle: string, rarity: string, myr: number) => ({
  handle,
  name: handle,
  rarity,
  market_value: myr / 4,
  marketPriceMyr: myr,
  image: `/${handle}.webp`,
  slab_image: `/${handle}-slab.webp`,
});
// Three Immortals and one Common: a pool whose shape would suggest 75% / 25%
// to anything that counted it.
const ODDS_ROWS = [
  card('a', 'Immortal', 900),
  card('b', 'Immortal', 800),
  card('c', 'Immortal', 700),
  card('d', 'Common', 5),
];
const ENTERED = { tiers: { Immortal: 0.2, Legendary: 2.4, Common: 97.4 } };

const serve = (body: unknown) => {
  const memory = backend({ 'GET /store/packs/:slug': { body } });
  return memory;
};

const PACK: ResolvedPack = {
  id: 'gold-pack',
  name: 'Gold Pack',
  priceMyr: 1200,
  image: '/g.webp',
  categoryId: 'pokemon',
  categoryName: 'Pokémon',
  icon: '/p.webp',
};

describe('getPackHighlights: pullOdds', () => {
  it('carries the same numbers the pack page odds board shows', async () => {
    serve({ odds: ODDS_ROWS, pull_odds: ENTERED });
    const highlights = await getPackHighlights('gold-pack');
    const detail = await getPackDetail('gold-pack');
    expect(highlights.pullOdds).toEqual(ENTERED);
    // The board's rows (PackDetailClient -> PackPullOdds) and the back's.
    expect(pullOddsRows(highlights.pullOdds!)).toEqual(
      pullOddsRows(detail!.pullOdds!),
    );
    expect(pullOddsRows(highlights.pullOdds!)).toEqual([
      { rarity: 'Immortal', chance: '0.2%' },
      { rarity: 'Legendary', chance: '2.4%' },
      { rarity: 'Common', chance: '97.4%' },
    ]);
    expect(packBackDetails(PACK, highlights.pullOdds).odds).toEqual([
      { label: 'Immortal', chance: '0.2%' },
      { label: 'Legendary', chance: '2.4%' },
      { label: 'Common', chance: '97.4%' },
    ]);
  });

  it('nothing entered: null, however full the pool is (never derived from it)', async () => {
    for (const pull_odds of [null, undefined, 'junk', [1, 2]]) {
      clearTtlCache();
      serve({ odds: ODDS_ROWS, pull_odds });
      const highlights = await getPackHighlights('gold-pack');
      expect(highlights.pullOdds, String(pull_odds)).toBeNull();
      // The pool is there all the same: the chase card still comes from it.
      expect(highlights.chase?.handle).toBe('a');
    }
  });

  it('only entered tiers, through the page parser: a bad value is dropped, never filled in', async () => {
    serve({
      odds: ODDS_ROWS,
      pull_odds: { tiers: { Immortal: 150, Common: 'x', Rare: 10 } },
    });
    const { pullOdds } = await getPackHighlights('gold-pack');
    // Immortal (out of range) and Common (not a number) are gone; nothing from
    // the pool's three Immortals and one Common takes their place.
    expect(pullOdds).toEqual({ tiers: { Rare: 10 } });
  });

  it('costs no extra request: one detail read per pack, as before', async () => {
    const memory = serve({ odds: ODDS_ROWS, pull_odds: ENTERED });
    await getPackHighlights('gold-pack');
    expect(memory.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      'GET /store/packs/gold-pack',
    ]);
  });

  it('an unreadable pool: no highlights and no odds', async () => {
    backend({ 'GET /store/packs/:slug': { status: 404, body: {} } });
    expect(await getPackHighlights('gone')).toEqual({
      chase: null,
      slabs: [],
      pullOdds: null,
    });
  });
});
