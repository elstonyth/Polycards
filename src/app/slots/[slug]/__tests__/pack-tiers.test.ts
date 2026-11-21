// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { storeShim, backend } from '@/lib/__tests__/store-shim';

// The tier projection the homepage flow fetches (/api/pack-tiers/<slug>) and the
// pack page's odds board reads. It must state exactly what the odds board
// states, carry nothing the page does not show, and never a chance for a pack
// without pull odds.

vi.mock('@/lib/store', () => ({ store: storeShim }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('next/cache', () => ({ unstable_cache: <F>(fn: F) => fn }));
vi.mock('@/components/Reveal', () => ({
  default: ({ children }: { children: React.ReactNode }) =>
    createElement('section', null, children),
}));

const { packTierRows, packTiersOf, pullOddsOf } =
  await import('@/lib/pack-tiers');
const { getPackTiers } = await import('@/lib/data/packs');
const { GET } = await import('@/app/api/pack-tiers/[slug]/route');
const { PackTiersResponseSchema, parseOne } =
  await import('@/lib/data/schemas');
const { clearTtlCache } = await import('@/lib/ttl-cache');
const { OddsBoard } = await import('../OddsBoard');
const { PackPullOdds } = await import('../PackDetailSections');
const { hasPullOddsContent } = await import('../OddsSheet');
const fmt = await import('@/lib/packs-format');
const { ticketCard } = await import('@/lib/packs-data');
type PackCard = import('@/lib/packs-data').PackCard;
type PackDetail = import('@/lib/data/packs').PackDetail;

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const card = (
  n: number,
  rarity: PackCard['rarity'],
  priceMyr: number | null,
): PackCard => ({
  handle: `card-${n}`,
  name: `Card ${n}`,
  set: 'Base',
  image: `/c${n}.png`,
  slabImage: `/s${n}.png`,
  rarity,
  priceMyr,
  pokemonDex: 25,
  spriteImage: null,
});
// Value-sorted, as getPackDetail hands it over.
const POOL = [
  card(1, 'Immortal', 9000),
  card(2, 'Immortal', 5000),
  card(3, 'Legendary', 800),
  card(4, 'Rare', 30),
  card(5, 'Uncommon', null),
  card(6, 'Common', 5),
  card(7, 'Common', 4),
];
const ODDS = {
  tiers: { Immortal: 0.2, Legendary: 2.4, Mythical: 3.4, Rare: 22, Common: 72 },
};
const CARDS: PackDetail = { topHits: [], pool: POOL, pullOdds: ODDS };
const TICKETS: PackDetail = {
  topHits: [],
  pool: [
    ticketCard(500, 'Immortal'),
    ticketCard(1000, 'Immortal'),
    ticketCard(50, 'Rare'),
    ticketCard(10, 'Common'),
  ],
  pullOdds: { tiers: { Immortal: 0.5, Rare: 19.5, Common: 80 } },
};

/** What PackDetailClient derived for the board before the projection. */
function boardFromPool(detail: PackDetail, tickets: boolean) {
  const oddsPool = tickets ? fmt.ticketOddsPool(detail.pool) : detail.pool;
  return {
    odds: detail.pullOdds ? fmt.pullOddsRows(detail.pullOdds) : null,
    range: fmt.poolValueRange(oddsPool),
    ev: detail.pullOdds
      ? fmt.poolExpectedValue(oddsPool, detail.pullOdds.tiers)
      : null,
    tierRanges: fmt.tierValueRanges(oddsPool),
  };
}

describe('packTierRows: the odds board numbers', () => {
  it.each([
    ['cards', CARDS, false],
    ['tickets', TICKETS, true],
  ] as const)('%s: chances, ranges and expected value match', (_n, d, t) => {
    const rows = packTierRows(d, t);
    const board = boardFromPool(d, t);
    expect(fmt.pullOddsRows({ tiers: pullOddsOf(rows.tiers) })).toEqual(
      board.odds,
    );
    expect(rows.ev).toBe(board.ev);
    expect(rows.range).toEqual(board.range);
    for (const tier of rows.tiers) {
      expect(tier.range).toEqual(board.tierRanges[tier.rarity] ?? null);
    }
  });

  it('lists every tier with cards or a chance, rarest first, with counts', () => {
    const rows = packTierRows(CARDS, false);
    expect(rows.tiers.map((t) => [t.rarity, t.chance, t.count])).toEqual([
      ['Immortal', 0.2, 2],
      ['Legendary', 2.4, 1],
      // A chance with no card in the pool.
      ['Mythical', 3.4, 0],
      ['Rare', 22, 1],
      // Cards with no chance.
      ['Uncommon', null, 1],
      ['Common', 72, 2],
    ]);
  });

  it('carries cards for the top tiers only, most valuable first', () => {
    const rows = packTierRows(CARDS, false);
    const cards = Object.fromEntries(
      rows.tiers.map((t) => [t.rarity, t.cards?.map((c) => c.handle)]),
    );
    expect(cards).toEqual({
      Immortal: ['card-1', 'card-2'],
      Legendary: ['card-3'],
      Mythical: [],
      Rare: undefined,
      Uncommon: undefined,
      Common: undefined,
    });
  });

  it("a tile carries the tile's display fields and nothing else", () => {
    const tile = packTierRows(CARDS, false).tiers[0]!.cards![0]!;
    expect(Object.keys(tile).sort()).toEqual(
      [
        'handle',
        'image',
        'name',
        'pokemonDex',
        'priceMyr',
        'rarity',
        'slabImage',
        'spriteImage',
      ].sort(),
    );
    const prize = packTierRows(TICKETS, true).tiers[0]!.cards![0]!;
    expect(prize).toMatchObject({ tickets: 1000, priceMyr: null });
  });

  it('a capsule: ticket ranges, biggest prize first', () => {
    const rows = packTierRows(TICKETS, true);
    expect(rows.tiers[0]).toMatchObject({
      rarity: 'Immortal',
      chance: 0.5,
      count: 2,
      range: { min: 500, max: 1000 },
    });
    expect(rows.tiers[0]!.cards!.map((c) => c.tickets)).toEqual([1000, 500]);
    // 750 x 0.005 + 50 x 0.195 + 10 x 0.8 = 21.5
    expect(rows.ev).toBe(21.5);
  });

  it('a capsule with no top tier carries every prize, as its Top Hits shows', () => {
    const rows = packTierRows(
      { ...TICKETS, pool: TICKETS.pool.slice(2) },
      true,
    );
    expect(rows.tiers.map((t) => t.cards?.map((c) => c.tickets))).toEqual([
      // Immortal: a chance, no prize.
      [],
      [50],
      [10],
    ]);
  });

  it('no pull odds: no chance, no expected value, no pack range', () => {
    const rows = packTierRows({ ...CARDS, pullOdds: null }, false);
    expect(rows.tiers.every((t) => t.chance === null)).toBe(true);
    expect(rows.ev).toBeNull();
    expect(rows.range).toBeNull();
    // And so the board stays hidden, by the board's own rule.
    expect(
      hasPullOddsContent(
        fmt.pullOddsRows({ tiers: pullOddsOf(rows.tiers) }),
        rows.range,
      ),
    ).toBe(false);
  });
});

describe('PackPullOdds renders the board PackDetailClient rendered', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const htmlOf = (el: React.ReactElement) => {
    act(() => root.render(el));
    return host.innerHTML;
  };

  it.each([
    ['cards', CARDS, false],
    ['tickets', TICKETS, true],
    ['odds with no tiers', { ...CARDS, pullOdds: { tiers: {} } }, false],
    [
      'odds that do not add up',
      { ...CARDS, pullOdds: { tiers: { Immortal: 1 } } },
      false,
    ],
  ] as const)('%s', (_n, d, t) => {
    const b = boardFromPool(d, t);
    const old = htmlOf(
      createElement(
        'section',
        null,
        createElement(OddsBoard, {
          heading: createElement('h2', null, 'Pull Odds (by rarity)'),
          odds: b.odds!,
          range: b.range,
          expectedValue: b.ev,
          tierRanges: b.tierRanges,
          tickets: t,
        }),
      ),
    );
    const now = htmlOf(
      createElement(PackPullOdds, {
        pack: { prizeType: t ? 'tickets' : undefined },
        tiers: packTierRows(d, t),
      }),
    );
    // The heading differs (SectionHead vs a bare h2): compare the board.
    const board = (html: string) => html.slice(html.indexOf('<p class'));
    expect(board(now)).toBe(board(old));
    expect(now).toContain('Pull Odds (by rarity)');
  });

  it('no pull odds: no board', () => {
    expect(
      htmlOf(
        createElement(PackPullOdds, {
          pack: {},
          tiers: packTierRows({ ...CARDS, pullOdds: null }, false),
        }),
      ),
    ).toBe('');
  });

  it('counts are opt-in', () => {
    const tiers = packTierRows(CARDS, false);
    expect(
      htmlOf(createElement(PackPullOdds, { pack: {}, tiers })),
    ).not.toMatch(/\d cards?</);
    const html = htmlOf(
      createElement(PackPullOdds, { pack: {}, tiers, counts: true }),
    );
    expect(host.textContent).toContain('2 cards');
    expect(host.textContent).toContain('1 card');
    expect(html).toContain('0 cards');
  });
});

describe('getPackTiers and GET /api/pack-tiers/<slug>', () => {
  beforeEach(() => {
    clearTtlCache();
    // the route answers only under the home preview's switch
    vi.stubEnv('HOME_PREVIEW', '1');
  });
  afterEach(() => vi.unstubAllEnvs());
  const catalog = (over: Record<string, unknown> = {}) => ({
    slug: 'gold-pack',
    title: 'Gold Pack',
    category: 'pokemon',
    price: 1200,
    image: '/gold.webp',
    rank: 1,
    buyback_percent: 90,
    in_stock: true,
    ...over,
  });
  const detailBody = {
    odds: [
      {
        handle: 'pikachu',
        name: 'Pikachu',
        rarity: 'Immortal',
        market_value: 100,
        marketPriceMyr: 400,
        image: '/p.webp',
        set: 'Promo',
        top_hit_order: null,
      },
      {
        handle: 'rattata',
        name: 'Rattata',
        rarity: 'Common',
        market_value: 1,
        marketPriceMyr: 4,
        image: '/r.webp',
      },
    ],
    // The key the backend sends.
    pull_odds: { tiers: { Immortal: 1, Common: 99 } },
  };
  const serve = (packs: unknown[], detail: unknown = detailBody) =>
    backend({
      'GET /store/packs': { body: { packs } },
      'GET /store/packs/:slug': { body: detail },
    });
  const get = async (slug: string) =>
    GET(new Request(`http://x/api/pack-tiers/${slug}`), {
      params: Promise.resolve({ slug }),
    });

  it('answers a catalogued pack with the slim shape', async () => {
    serve([catalog()]);
    const res = await get('gold-pack');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['ev', 'pack', 'range', 'tiers']);
    expect(body.pack).toEqual({
      priceMyr: 1200,
      buybackPercent: 90,
      inStock: true,
    });
    expect(parseOne(PackTiersResponseSchema, body)).not.toBeNull();
    // Owner rule: nothing a browser receives says "published".
    expect(JSON.stringify(body)).not.toMatch(/publish/i);
    // Nothing from the roll settings: no weights, no odds sets.
    expect(JSON.stringify(body)).not.toMatch(/weight|odds|set"|market_value/i);
    expect(body).toEqual(
      packTiersOf(
        { priceMyr: 1200, buybackPercent: 90 },
        {
          pool: [
            {
              handle: 'pikachu',
              name: 'Pikachu',
              image: '/p.webp',
              slabImage: null,
              rarity: 'Immortal',
              priceMyr: 400,
              pokemonDex: null,
              spriteImage: null,
            },
            {
              handle: 'rattata',
              name: 'Rattata',
              image: '/r.webp',
              slabImage: null,
              rarity: 'Common',
              priceMyr: 4,
              pokemonDex: null,
              spriteImage: null,
            },
          ],
          pullOdds: { tiers: { Immortal: 1, Common: 99 } },
        },
      ),
    );
  });

  it('a capsule states no buyback', async () => {
    serve(
      [
        catalog({
          slug: 'gold-capsule',
          category: 'poly',
          prize_type: 'tickets',
        }),
      ],
      {
        prize_type: 'tickets',
        odds: [
          {
            handle: 'tickets-300',
            tickets: 300,
            name: '300',
            rarity: 'Immortal',
            image: '/t.webp',
          },
        ],
        pull_odds: { tiers: { Immortal: 100 } },
      },
    );
    const tiers = await getPackTiers('gold-capsule');
    expect(tiers?.pack.buybackPercent).toBeNull();
    expect(tiers?.tiers[0]).toMatchObject({ rarity: 'Immortal', chance: 100 });
    expect(tiers?.tiers[0]?.cards?.[0]?.tickets).toBe(300);
  });

  it('a pack without pull odds sends no chance at all', async () => {
    serve([catalog()], { ...detailBody, pull_odds: null });
    const tiers = await getPackTiers('gold-pack');
    expect(tiers?.tiers.map((t) => t.chance)).toEqual([null, null]);
    expect(tiers?.ev).toBeNull();
    expect(tiers?.range).toBeNull();
  });

  it('404s an unknown slug without reading its pool', async () => {
    serve([catalog()]);
    const res = await get('made-up');
    expect(res.status).toBe(404);
    expect(await getPackTiers('made-up')).toBeNull();
  });

  it('404s a pack whose pool cannot be read', async () => {
    backend({
      'GET /store/packs': { body: { packs: [catalog()] } },
      'GET /store/packs/:slug': { status: 404, body: { message: 'nope' } },
    });
    expect((await get('gold-pack')).status).toBe(404);
  });
});
