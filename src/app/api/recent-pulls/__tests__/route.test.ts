import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// The loaders read through the `Store` port; an in-memory backend seeds them
// so the real getPackCategories/getRecentPulls parse path runs and the
// catalog-bounded key gate is exercised for real.
//
// The pack_id/rarity params now ride the port's `query` option rather than a
// hand-built querystring in the path, so the assertions below read
// `request.query` where they used to read the tail of the path. Same URL on
// the wire; the SDK serializes it.
import { storeShim, backend } from '@/lib/__tests__/store-shim';
import type { MemoryRoutes } from '@/lib/store-memory';

vi.mock('@/lib/store', () => ({ store: storeShim }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { GET } from '@/app/api/recent-pulls/route';
import { clearTtlCache } from '@/lib/ttl-cache';

const packRow = (over: Record<string, unknown> = {}) => ({
  slug: 'bronze-pack',
  title: 'Bronze Pack',
  category: 'pokemon',
  price: 10,
  image: '/bronze.webp',
  display_image: null,
  boost: false,
  rank: 1,
  buyback_percent: 90,
  in_stock: true,
  ...over,
});

const req = (query = '') =>
  new NextRequest(`http://localhost/api/recent-pulls${query}`);

/** The backend every case starts from: one catalog pack, an empty feed, and a
 *  404 for any pack the catalog does not list (which is what the real detail
 *  route answers, and what makes resolveFeedPackSlug discard a garbage slug). */
const seed = (over: MemoryRoutes = {}) =>
  backend({
    'GET /store/packs': { body: { packs: [packRow()] } },
    'GET /store/packs/:slug': { status: 404, body: { message: 'not found' } },
    'GET /store/pulls/recent': { body: { pulls: [] } },
    ...over,
  });

let mem: ReturnType<typeof seed>;
const pullsCallsOf = () =>
  mem.requests.filter((r) => r.path === '/store/pulls/recent');
const packsCallsOf = () =>
  mem.requests.filter((r) => r.path.startsWith('/store/packs'));

beforeEach(() => {
  // Both getPackCategories (catalog) and getRecentPulls (feed) are memoised
  // per process — without this the FIRST test's catalog/feed would be served
  // to every later case.
  clearTtlCache();
  mem = seed();
});

describe('GET /api/recent-pulls — catalog-bounded key gate (plan 117 step 2)', () => {
  it('an unknown-but-valid-shaped pack_id collapses to the SAME memo as no pack_id', async () => {
    await GET(req('?pack_id=totally-not-a-real-pack'));
    await GET(req());

    // One shared cache key ('recent-pulls:') means only ONE backend call for
    // both requests — the second was a memo hit, not a fresh miss.
    expect(pullsCallsOf()).toHaveLength(1);
    // And the shared call hit the GLOBAL endpoint (no pack_id), not a
    // per-garbage-key scoped one — the query key is omitted entirely.
    expect(pullsCallsOf()[0]!.query).toBeUndefined();
  });

  it('a real catalog slug keeps its own cache key, distinct from the global feed', async () => {
    await GET(req('?pack_id=bronze-pack'));
    await GET(req());

    expect(pullsCallsOf()).toHaveLength(2);
    expect(pullsCallsOf()[0]!.query).toEqual({ pack_id: 'bronze-pack' });
    expect(pullsCallsOf()[1]!.query).toBeUndefined();
  });

  // The free welcome pack is reachable (GET /store/packs/:slug) but never
  // listed (GET /store/packs filters free_welcome out), so a catalog-only gate
  // flipped its spin page to the GLOBAL feed on the first poll.
  it('an unlisted-but-reachable pack (the free pack) keeps its own scoped key', async () => {
    mem = seed({
      'GET /store/packs/:slug': {
        body: {
          pack: packRow({
            slug: 'free-welcome-pack',
            category: 'free_welcome',
          }),
        },
      },
    });

    await GET(req('?pack_id=free-welcome-pack'));

    expect(pullsCallsOf()[0]!.query).toEqual({
      pack_id: 'free-welcome-pack',
    });
  });

  it('a known tier is forwarded on its own key; a garbage tier collapses to the unfiltered memo', async () => {
    await GET(req('?pack_id=bronze-pack&rarity=Immortal'));
    await GET(req('?pack_id=bronze-pack&rarity=Shiny'));
    await GET(req('?pack_id=bronze-pack'));

    // Immortal minted its own call; Shiny and the bare request shared one.
    expect(pullsCallsOf()).toHaveLength(2);
    // pack_id before rarity, as the hand-built querystring had it.
    expect(Object.entries(pullsCallsOf()[0]!.query!)).toEqual([
      ['pack_id', 'bronze-pack'],
      ['rarity', 'Immortal'],
    ]);
    expect(pullsCallsOf()[1]!.query).toEqual({ pack_id: 'bronze-pack' });
  });

  it('the body carries the drought counters alongside the rows', async () => {
    mem = seed({
      'GET /store/pulls/recent': {
        body: { pulls: [], drought: { Immortal: 303, Shiny: 1, Rare: -1 } },
      },
    });

    const body = await (await GET(req())).json();
    // Unknown tiers and negative counts are dropped at the trust boundary.
    expect(body).toEqual({ pulls: [], drought: { Immortal: 303 } });
  });

  it('resolving the catalog costs no extra backend hop (getPackCategories is already cached)', async () => {
    await GET(req());
    const packsCallsBefore = packsCallsOf().length;
    await GET(req('?pack_id=bronze-pack'));
    const packsCallsAfter = packsCallsOf().length;

    // No pack_id → the shape gate short-circuits before any catalog read.
    expect(packsCallsBefore).toBe(0);
    // A catalog slug costs ONE read, served by the 30s memo from then on.
    expect(packsCallsAfter).toBe(1);
    await GET(req('?pack_id=bronze-pack&rarity=Legendary'));
    expect(packsCallsOf()).toHaveLength(1);
  });
});

// Deployment skew: these URLs are also polled by already-open, older tabs.
describe('polling JSON compatibility aliases', () => {
  const wire = {
    handle: 'charizard',
    name: 'Charizard',
    image: '/card.png',
    slab_image: '/slab.png',
    rarity: 'Rare',
    market_value: 7,
    pokemon_dex: 6,
    sprite_image: '/sprite.png',
  };
  it('card detail preserves every legacy field alongside the numeric CardView', async () => {
    const { GET: cardGet } = await import('@/app/api/cards/[handle]/route');
    const oldCard = {
      ...wire,
      marketPriceMyr: 1234.5,
      set: 'Base',
      grader: 'PSA',
      grade: '10',
      pcSyncedAt: null,
      priceHistory: [{ date: '2026-09-01', valueMyr: 1200 }],
    };
    seed({ 'GET /store/cards/:handle': { body: { card: oldCard } } });
    const response = await cardGet(
      new Request('http://localhost/api/cards/charizard'),
      { params: Promise.resolve({ handle: 'charizard' }) },
    );
    const { card } = await response.json();
    expect(card).toEqual({
      handle: 'charizard',
      name: 'Charizard',
      image: '/card.png',
      slab_image: '/slab.png',
      rarity: 'Rare',
      pokemon_dex: 6,
      sprite_image: '/sprite.png',
      marketPriceMyr: 1234.5,
      set: 'Base',
      grader: 'PSA',
      grade: '10',
      pcSyncedAt: null,
      priceHistory: [{ date: '2026-09-01', valueMyr: 1200 }],
      priceMyr: 1234.5,
      slabImage: '/slab.png',
      pokemonDex: 6,
      spriteImage: '/sprite.png',
    });
    // Old detail rendering must still be able to format the polled number.
    expect(
      card.marketPriceMyr.toLocaleString('en-US', { minimumFractionDigits: 2 }),
    ).toBe('1,234.50');
  });
  it('pack pool and top hits preserve selection ids and formatted prices in their existing orders', async () => {
    const { GET: packGet } = await import('@/app/api/pack-detail/[slug]/route');
    seed({
      'GET /store/packs/:slug': {
        body: {
          odds: [
            { ...wire, handle: 'unpriced', market_value: 20, top_hit_order: 1 },
            {
              ...wire,
              handle: 'priced',
              marketPriceMyr: 1234.5,
              top_hit_order: 2,
            },
            { ...wire, handle: 'zero', marketPriceMyr: 0 },
          ],
          published_odds: { Rare: 100 },
        },
      },
    });
    const response = await packGet(
      new Request('http://localhost/api/pack-detail/bronze-pack'),
      { params: Promise.resolve({ slug: 'bronze-pack' }) },
    );
    const { detail } = await response.json();
    expect(
      detail.pool.map((row: Record<string, unknown>) => [
        row.id,
        row.handle,
        row.value,
        row.priceMyr,
      ]),
    ).toEqual([
      ['priced', 'priced', 'RM 1,234.50', 1234.5],
      ['unpriced', 'unpriced', '—', null],
      ['zero', 'zero', 'RM 0.00', 0],
    ]);
    expect(
      detail.topHits.map((row: Record<string, unknown>) => [row.id, row.value]),
    ).toEqual([
      ['unpriced', '—'],
      ['priced', 'RM 1,234.50'],
    ]);
    expect(detail.pool[0]).toMatchObject({
      name: 'Charizard',
      image: '/card.png',
      slabImage: '/slab.png',
      rarity: 'Rare',
      pokemonDex: 6,
      spriteImage: '/sprite.png',
    });
  });
  it('recent rows retain legacy prices and labels without replacing pull ids with card handles', async () => {
    seed({
      'GET /store/pulls/recent': {
        body: {
          pulls: [
            {
              ...wire,
              id: 'pull-priced',
              marketPriceMyr: 1234.5,
              rolled_at: '2026-09-01T00:00:00Z',
            },
            { ...wire, id: 'pull-unpriced', rolled_at: '2026-09-01T00:00:00Z' },
            {
              ...wire,
              id: 'pull-zero',
              marketPriceMyr: 0,
              rolled_at: '2026-09-01T00:00:00Z',
            },
          ],
        },
      },
    });
    const response = await GET(req());
    const { pulls } = await response.json();
    expect(
      pulls.map((row: Record<string, unknown>) => [
        row.id,
        row.handle,
        row.value,
        row.priceMyr,
      ]),
    ).toEqual([
      ['pull-priced', 'charizard', 'RM 1,234.50', 1234.5],
      ['pull-unpriced', 'charizard', '—', null],
      ['pull-zero', 'charizard', 'RM 0.00', 0],
    ]);
    expect(pulls[0]).toMatchObject({
      name: 'Charizard',
      image: '/card.png',
      slabImage: '/slab.png',
      packName: 'Mystery Pack',
      who: 'Anonymous',
      profileHandle: null,
      avatar: null,
      frame: null,
      rolledAt: '2026-09-01T00:00:00Z',
    });
  });
});
