import {
  cogsSection,
  costAsOf,
  type CostOf,
  packSalesSection,
  rateOn,
  shippingSection,
  totalsSection,
  type CogsWindowRows,
  type PackMeta,
  type PackWindowRows,
} from '../pnl';

const pack = (
  slug: string,
  category: string | null,
  pack_type: string | null,
  price_sen: number,
  prize_type: string | null = 'cards',
): PackMeta => ({
  slug,
  title: slug.toUpperCase(),
  category,
  pack_type,
  prize_type,
  price_sen,
});

const META: PackMeta[] = [
  pack('bronze-pack', 'pokemon', 'classic', 30000),
  pack('silver-pack', 'pokemon', 'classic', 60000),
  pack('151', 'pokemon', 'original', 4000),
  pack('poncho-pack', 'pokemon', 'special', 2200000),
  pack('free-151', 'free_welcome', null, 0),
  pack('lucky-pack', 'poly', null, 1000, 'tickets'),
];

const rows = (r: Partial<PackWindowRows> = {}): PackWindowRows => ({
  paid: new Map(),
  opens: new Map(),
  free: [],
  ...r,
});

describe('packSalesSection', () => {
  it('counts paid opens at full price (cash + bonus share) plus free packs at pack price', () => {
    const s = packSalesSection(
      META,
      rows({
        paid: new Map([['bronze-pack', { full_sen: 90000, bonus_sen: 10000 }]]),
        opens: new Map([['bronze-pack', 3]]),
        free: [
          { slug: 'bronze-pack', source: 'adjustment', qty: 10 },
          { slug: 'bronze-pack', source: 'checkin', qty: 1 },
        ],
      }),
      null,
    );
    const bronze = s.franchises[0].types[0].packs[0];
    expect(bronze.slug).toBe('bronze-pack');
    expect(bronze.current).toEqual({
      opens: 3,
      paid_sen: 90000,
      bonus_sen: 10000,
      free_qty: { adjustment: 10, checkin: 1, task: 0, welcome: 0, other: 0 },
      // "bronze 10qty 3000myr": 10 × RM 300, plus the check-in one.
      free_sen: 11 * 30000,
      total_sen: 90000 + 11 * 30000,
    });
    expect(bronze.previous).toBeNull();
    expect(s.total).toEqual({
      current_sen: 90000 + 330000,
      previous_sen: null,
    });
  });

  it('groups franchise → type → pack: original, special, classic; packs by price', () => {
    const paid = new Map([
      ['silver-pack', { full_sen: 60000, bonus_sen: 0 }],
      ['bronze-pack', { full_sen: 30000, bonus_sen: 0 }],
      ['151', { full_sen: 4000, bonus_sen: 0 }],
      ['poncho-pack', { full_sen: 2200000, bonus_sen: 0 }],
    ]);
    const s = packSalesSection(META, rows({ paid }), rows());
    const poke = s.franchises.find((f) => f.category === 'pokemon')!;
    expect(poke.types.map((t) => t.pack_type)).toEqual([
      'original',
      'special',
      'classic',
    ]);
    expect(poke.types[2].packs.map((p) => p.slug)).toEqual([
      'bronze-pack',
      'silver-pack',
    ]);
    expect(poke.types[2].total).toEqual({
      current_sen: 90000,
      previous_sen: 0,
    });
    expect(poke.total.current_sen).toBe(2294000);
  });

  it('leaves Lucky Draw capsules out (they belong to the Lucky Draw section)', () => {
    const s = packSalesSection(
      META,
      rows({
        paid: new Map([['lucky-pack', { full_sen: 5000, bonus_sen: 0 }]]),
        opens: new Map([['lucky-pack', 5]]),
      }),
      null,
    );
    expect(s.franchises).toEqual([]);
    expect(s.total.current_sen).toBe(0);
  });

  it('counts welcome packs in qty but at RM 0', () => {
    const s = packSalesSection(
      META,
      rows({ free: [{ slug: 'free-151', source: 'welcome', qty: 40 }] }),
      null,
    );
    const w = s.franchises[0].types[0].packs[0];
    expect(w.current.free_qty.welcome).toBe(40);
    expect(w.current.total_sen).toBe(0);
    expect(s.total.current_sen).toBe(0);
  });

  it('values welcome packs at RM 0 even on a priced pack (decision 20, review F4)', () => {
    const s = packSalesSection(
      META,
      rows({
        free: [
          { slug: '151', source: 'welcome', qty: 5 },
          { slug: '151', source: 'task', qty: 2 },
        ],
      }),
      null,
    );
    const p151 = s.franchises[0].types[0].packs[0];
    expect(p151.current.free_qty.welcome).toBe(5);
    expect(p151.current.free_sen).toBe(2 * 4000);
  });

  it('keeps charges with no pack as unattributed, inside the total', () => {
    const s = packSalesSection(
      META,
      rows({ paid: new Map([[null, { full_sen: 700, bonus_sen: 0 }]]) }),
      rows({ paid: new Map([[null, { full_sen: 300, bonus_sen: 0 }]]) }),
    );
    expect(s.unattributed).toEqual({ current_sen: 700, previous_sen: 300 });
    expect(s.total).toEqual({ current_sen: 700, previous_sen: 300 });
  });

  it('shows a pack active only in the previous window, and an unknown slug under other', () => {
    const s = packSalesSection(
      META,
      rows({ paid: new Map([['gone-pack', { full_sen: 100, bonus_sen: 0 }]]) }),
      rows({ paid: new Map([['151', { full_sen: 4000, bonus_sen: 0 }]]) }),
    );
    const p151 = s.franchises.find((f) => f.category === 'pokemon')!.types[0]
      .packs[0];
    expect(p151.current.total_sen).toBe(0);
    expect(p151.previous!.total_sen).toBe(4000);
    const other = s.franchises.find((f) => f.category === null)!;
    expect(other.types[0].packs[0]).toMatchObject({
      slug: 'gone-pack',
      title: 'gone-pack',
    });
  });
});

describe('rateOn', () => {
  const rates = [
    { day: '2026-11-10', rate: 4.2 },
    { day: '2026-11-12', rate: 4.3 },
  ];
  it("uses the day's rate, else the nearest earlier saved day, else the fallback", () => {
    expect(rateOn('2026-11-12', rates, 4.0)).toBe(4.3);
    expect(rateOn('2026-11-11', rates, 4.0)).toBe(4.2);
    expect(rateOn('2026-11-30', rates, 4.0)).toBe(4.3);
    expect(rateOn('2026-11-01', rates, 4.0)).toBe(4.0);
  });
});

const costsOf =
  (m: Map<string, number | null>): CostOf =>
  (h) =>
    m.get(h) ?? null;

describe('costAsOf', () => {
  const lines = [
    { day: '2026-10-01', qty: 2, unit_cost: 100 },
    { day: '2026-11-10', qty: 2, unit_cost: 200 },
  ];
  it('averages only the invoices dated on or before the day, so later invoices never move it', () => {
    expect(costAsOf(lines, '2026-10-31')).toBe(100);
    expect(costAsOf(lines, '2026-11-10')).toBe(150);
    expect(costAsOf(lines, null)).toBe(150);
  });
  it('falls back to every invoice when none is dated by then (a late-booked invoice beats an estimate)', () => {
    expect(costAsOf(lines, '2026-09-01')).toBe(150);
    expect(costAsOf([], '2026-09-01')).toBeNull();
  });
});

describe('cogsSection', () => {
  const cogsRows = (r: Partial<CogsWindowRows> = {}): CogsWindowRows => ({
    buyback: new Map(),
    pulled: [],
    shipped: [],
    purchase_sen: 0,
    ...r,
  });
  const rates = [{ day: '2026-11-01', rate: 4 }];

  it('COGS = buyback paid + supplier cost of shipped cards; card value pulled is info only', () => {
    const s = cogsSection(
      META,
      cogsRows({
        buyback: new Map([['bronze-pack', 25000]]),
        pulled: [{ slug: 'bronze-pack', day: '2026-11-02', usd: 100, n: 2 }],
        shipped: [
          {
            slug: 'bronze-pack',
            handle: 'charizard',
            day: '2026-11-03',
            n: 2,
            market_usd: 50,
          },
        ],
        purchase_sen: 999,
      }),
      null,
      costsOf(new Map([['charizard', 120.5]])),
      rates,
      4.5,
    );
    const b = s.franchises[0].types[0].packs[0];
    expect(b.current).toEqual({
      pulls: 2,
      pulled_sen: 40000, // US$100 × 4.0 (saved rate on or before 11-02)
      buyback_sen: 25000,
      shipped_cards: 2,
      shipped_cost_sen: 2 * 12050,
      estimated_cards: 0,
      total_sen: 25000 + 24100,
    });
    expect(s.total).toEqual({ current_sen: 49100, previous_sen: null });
    expect(s.pulled).toEqual({ current_sen: 40000, previous_sen: null });
    expect(s.purchase).toEqual({ current_sen: 999, previous_sen: null });
  });

  it('estimates a shipped card with no supplier cost at market value × that day’s rate, and counts it', () => {
    const s = cogsSection(
      META,
      cogsRows({
        shipped: [
          {
            slug: '151',
            handle: 'mew',
            day: '2026-11-05',
            n: 3,
            market_usd: 10,
          },
        ],
      }),
      cogsRows(),
      costsOf(new Map([['mew', null]])),
      rates,
      4.5,
    );
    const p = s.franchises[0].types[0].packs[0];
    expect(p.current.shipped_cost_sen).toBe(3 * 4000);
    expect(p.current.estimated_cards).toBe(3);
    expect(s.estimated_cards).toBe(3);
    expect(p.previous?.total_sen).toBe(0);
    expect(s.total).toEqual({ current_sen: 12000, previous_sen: 0 });
  });

  it('falls back to the current rate before any saved day', () => {
    const s = cogsSection(
      META,
      cogsRows({ pulled: [{ slug: '151', day: '2026-10-01', usd: 10, n: 1 }] }),
      null,
      costsOf(new Map()),
      rates,
      4.5,
    );
    expect(s.pulled.current_sen).toBe(4500);
    // Pulled value alone is info: the pack shows, COGS stays 0.
    expect(s.total.current_sen).toBe(0);
  });
});

describe('shippingSection', () => {
  it('splits delivery charge and insurance, and totals them as other revenue', () => {
    const s = shippingSection(
      { shipping_sen: 1500, insurance_sen: 250, orders: 3 },
      { shipping_sen: 1000, insurance_sen: 0, orders: 2 },
    );
    expect(s).toEqual({
      shipping: { current_sen: 1500, previous_sen: 1000 },
      insurance: { current_sen: 250, previous_sen: 0 },
      total: { current_sen: 1750, previous_sen: 1000 },
      orders: { current: 3, previous: 2 },
    });
    expect(
      shippingSection({ shipping_sen: 1, insurance_sen: 2, orders: 1 }, null)
        .total,
    ).toEqual({
      current_sen: 3,
      previous_sen: null,
    });
  });
});

describe('totalsSection', () => {
  const p = (c: number, prev: number | null = null) => ({
    current_sen: c,
    previous_sen: prev,
  });
  it('revenue + other revenue = total; total − COGS = gross; gross − marketing = net', () => {
    const t = totalsSection({
      revenue: {
        pack_sales: p(1000, 800),
        coin_flip: p(50, 40),
        lucky_draw: p(30, 0),
      },
      other_revenue: { shipping: p(20, 10) },
      cogs: { packs: p(700, 600), coin_flip: p(60, 30), lucky_draw: p(10, 0) },
      marketing: p(100, 90),
    });
    expect(t.revenue).toEqual(p(1080, 840));
    expect(t.other_revenue).toEqual(p(20, 10));
    expect(t.total_revenue).toEqual(p(1100, 850));
    expect(t.cogs).toEqual(p(770, 630));
    expect(t.gross).toEqual(p(330, 220));
    expect(t.marketing).toEqual(p(100, 90));
    expect(t.net).toEqual(p(230, 130));
  });
  it('keeps previous null when any part has no previous window', () => {
    const t = totalsSection({
      revenue: { pack_sales: p(10) },
      other_revenue: {},
      cogs: {},
      marketing: p(1),
    });
    expect(t.net).toEqual(p(9, null));
  });
});
