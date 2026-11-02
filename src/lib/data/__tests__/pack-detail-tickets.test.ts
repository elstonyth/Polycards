import { describe, it, expect, vi, beforeEach } from 'vitest';

// A ticket pack's rows reach the storefront as one odds row per amount, with no
// weight. They become pool cards the reel and the guest demo can sample, and
// must never read as a priced card anywhere the storefront sums value.
import { storeShim, backend } from '@/lib/__tests__/store-shim';

vi.mock('@/lib/store', () => ({ store: storeShim }));
vi.mock('@/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('next/cache', () => ({
  unstable_cache: <F>(fn: F) => fn,
}));

import {
  getPackBySlug,
  getPackDetail,
  getPackHighlights,
} from '@/lib/data/packs';
import { PackPollResponseSchema, parseOne } from '@/lib/data/schemas';
import { TICKET_ART } from '@/lib/packs-data';
import { clearTtlCache } from '@/lib/ttl-cache';

beforeEach(() => clearTtlCache());

const row = (tickets: unknown, rarity: string) => ({
  handle: `tickets-${tickets}`,
  tickets,
  name: `${tickets} Tickets`,
  rarity,
  market_value: 0,
  image: TICKET_ART,
});

const TICKET_DETAIL = {
  prize_type: 'tickets',
  odds: [row(10, 'Common'), row(1000, 'Immortal')],
  published_odds: { tiers: { Immortal: 0.1, Common: 99.9 } },
};

const serve = (body: unknown) =>
  backend({ 'GET /store/packs/:slug': { body } });

describe('getPackDetail — ticket pack', () => {
  it('turns each amount into a pool card with no price and no top hits', async () => {
    serve(TICKET_DETAIL);
    const d = await getPackDetail('lucky-pack');
    expect(d?.topHits).toEqual([]);
    expect(d?.pool.map((c) => [c.tickets, c.rarity, c.priceMyr])).toEqual([
      [10, 'Common', null],
      [1000, 'Immortal', null],
    ]);
    expect(d?.pool[0]?.spriteImage).toBe(TICKET_ART);
    expect(d?.publishedOdds).toEqual({
      tiers: { Immortal: 0.1, Common: 99.9 },
    });
  });

  it('drops a bad row and keeps one with no market_value', async () => {
    const { market_value: _omitted, ...bare } = row(50, 'Rare');
    serve({ ...TICKET_DETAIL, odds: [row(0, 'Common'), bare] });
    const d = await getPackDetail('lucky-pack');
    expect(d?.pool.map((c) => c.tickets)).toEqual([50]);
  });

  // The pack page's 60s poll parses the detail through a stripping schema.
  it('survives the pack page poll', async () => {
    serve(TICKET_DETAIL);
    const d = await getPackDetail('lucky-pack');
    const polled = parseOne(
      PackPollResponseSchema,
      JSON.parse(JSON.stringify({ detail: d })),
    );
    expect(polled?.detail.pool.map((c) => c.tickets)).toEqual([10, 1000]);
  });

  it('gives the home page nothing to highlight', async () => {
    serve(TICKET_DETAIL);
    expect(await getPackHighlights('lucky-pack')).toEqual({
      chase: null,
      slabs: [],
    });
  });
});

describe('getPackDetail — card pack', () => {
  it('parses as before, with no prize_type and no tickets', async () => {
    serve({
      odds: [
        {
          handle: 'charizard',
          name: 'Charizard',
          rarity: 'Legendary',
          market_value: 100,
          marketPriceMyr: 400,
          image: '/charizard.webp',
        },
      ],
    });
    const d = await getPackDetail('bronze-pack');
    expect(d?.pool[0]).toMatchObject({ handle: 'charizard', priceMyr: 400 });
    expect(d?.pool[0]).not.toHaveProperty('tickets');
  });
});

describe('getPackBySlug — prize_type', () => {
  const pack = (over: Record<string, unknown>) => ({
    slug: 'lucky-pack',
    title: 'Lucky Pack',
    category: 'poly',
    price: 10,
    image: '/images/polycards/lucky-pack.webp',
    boost: true,
    rank: 1,
    ...over,
  });
  const base = async (over: Record<string, unknown>) => {
    backend({
      'GET /store/packs': { body: { packs: [pack(over)] } },
    });
    return (await getPackBySlug('lucky-pack'))?.pack;
  };

  it('marks a ticket pack and drops its buyback badge', async () => {
    const p = await base({ prize_type: 'tickets' });
    expect(p?.prizeType).toBe('tickets');
    expect(p?.boost).toBeUndefined();
  });

  it.each([[{ prize_type: 'cards' }], [{}], [{ prize_type: 'bogus' }]])(
    'reads %j as a card pack',
    async (over) => {
      const p = await base(over);
      expect(p?.prizeType).toBeUndefined();
      expect(p?.boost).toBe(true);
    },
  );
});
