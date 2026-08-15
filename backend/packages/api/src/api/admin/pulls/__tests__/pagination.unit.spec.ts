import { GET } from '../route';

const mkRes = () => {
  const out: { body?: any; status?: number } = {};
  return {
    res: {
      json: (b: any) => {
        out.body = b;
      },
      status: (s: number) => {
        out.status = s;
        return { json: (b: any) => (out.body = b) };
      },
    } as any,
    out,
  };
};

const pull = (i: number, over: Record<string, any> = {}) => ({
  id: `pull_${i}`,
  rolled_at: new Date(2026, 0, i + 1),
  customer_id: 'cus_1',
  pack_id: 'pack_1',
  card_id: 'card-a',
  status: 'vaulted',
  buyback_amount: null,
  source: 'pack',
  ...over,
});

function mkScope(totalPulls: number, extra: any[] = []) {
  const all = [
    ...Array.from({ length: totalPulls }, (_, i) => pull(i)),
    ...extra,
  ];
  // Filters each list call actually received — the ?source= tests assert the
  // ledger is filtered while the rollup window keeps its own fixed scope.
  const seen: { rollup?: any; ledger?: any } = {};
  // Both list mocks HONOR filter.source: a rollup-scope assertion that only
  // inspected `seen` would pass even if the route ignored the filter.
  const match = (rows: any[], f: any) =>
    f?.source ? rows.filter((r) => r.source === f.source) : rows;
  const packs = {
    listPulls: async (f: any, o: any) => {
      seen.rollup = f;
      return match(all, f).slice(0, o?.take ?? all.length);
    },
    listAndCountPulls: async (f: any, o: any) => {
      seen.ledger = f;
      const rows = match(all, f);
      return [
        rows.slice(o?.skip ?? 0, (o?.skip ?? 0) + (o?.take ?? 50)),
        rows.length,
      ];
    },
    listCards: async () => [
      { handle: 'card-a', name: 'Card A', market_value: 10, image: 'x.png' },
    ],
    listPackOdds: async () => [],
    // Pull.pack_id stores the pack SLUG (= Pack.slug) — the route joins by
    // slug (plan 012), so the mock must carry one; a slug-less pack is exactly
    // the bug the join fix addressed.
    listPacks: async () => [
      { id: 'pack_internal_1', slug: 'pack_1', title: 'Starter Pack' },
    ],
    listFxRates: async () => [],
  };
  return {
    seen,
    resolve: (key: string) =>
      typeof key === 'string' && key.toLowerCase().includes('customer')
        ? { listCustomers: async () => [{ id: 'cus_1', email: 'a@b.c' }] }
        : packs,
  };
}

describe('GET /admin/pulls pagination', () => {
  it('returns the true total and honors offset/limit', async () => {
    const { res, out } = mkRes();
    await GET(
      { scope: mkScope(120), query: { limit: '50', offset: '50' } } as any,
      res,
    );
    expect(out.body.total).toBe(120);
    expect(out.body.offset).toBe(50);
    expect(out.body.limit).toBe(50);
    expect(out.body.pulls).toHaveLength(50);
  });

  it('joins the pack title onto ledger rows', async () => {
    const { res, out } = mkRes();
    await GET({ scope: mkScope(3), query: {} } as any, res);
    expect(out.body.pulls[0].pack_title).toBe('Starter Pack');
  });

  it('rejects limit above 100', async () => {
    const { res } = mkRes();
    await expect(
      GET({ scope: mkScope(1), query: { limit: '500' } } as any, res),
    ).rejects.toThrow(/limit/);
  });

  // ?source= backs the All Orders "Pack purchases" tab: reward-economy pulls
  // must not render as purchases.
  it('passes ?source= through to the ledger query', async () => {
    const { res } = mkRes();
    const scope = mkScope(3);
    await GET({ scope, query: { source: 'pack' } } as any, res);
    expect(scope.seen.ledger).toEqual({ source: 'pack' });
  });

  it('keeps the rollup window on its own scope when ?source= is set', async () => {
    const { res } = mkRes();
    const scope = mkScope(3);
    await GET({ scope, query: { source: 'free' } } as any, res);
    // Rollups are global stats, not a view of the current page — the page's
    // ?source= never reaches them, and their own scope is purchased pulls.
    expect(scope.seen.rollup).toEqual({ source: 'pack' });
  });

  // Giveaway pulls are not purchases: a free-welcome (or reward) pull must not
  // inflate top cards / top rarities, the same rule the public boards follow.
  it('excludes non-pack pulls from the rollups', async () => {
    const freebie = pull(99, { source: 'free', card_id: 'card-free' });
    const { res, out } = mkRes();
    await GET({ scope: mkScope(3, [freebie]), query: {} } as any, res);

    const { res: res2, out: baseline } = mkRes();
    await GET({ scope: mkScope(3), query: {} } as any, res2);

    expect(out.body.topCards).toEqual(baseline.body.topCards);
    expect(out.body.topCards.map((c: any) => c.handle)).not.toContain(
      'card-free',
    );
    // ...but the free pull IS still in the operator's ledger page.
    expect(out.body.pulls.map((p: any) => p.id)).toContain('pull_99');
  });

  it('rejects an unknown ?source=', async () => {
    const { res, out } = mkRes();
    const scope = mkScope(3);
    await GET({ scope, query: { source: 'bogus' } } as any, res);
    expect(out.status).toBe(400);
    expect(out.body.message).toMatch(/source/i);
    // Bailed before touching the ledger.
    expect(scope.seen.ledger).toBeUndefined();
  });

  // ?customer_id= is the player tab: scoped table, no global rollups.
  it('scopes the ledger to ?customer_id= and skips the rollup fetch', async () => {
    const { res, out } = mkRes();
    const scope = mkScope(3);
    await GET({ scope, query: { customer_id: ' cus_1 ' } } as any, res);
    expect(scope.seen.ledger).toEqual({ customer_id: 'cus_1' });
    // The rollup window is never fetched for a scoped view.
    expect(scope.seen.rollup).toBeUndefined();
    expect(out.body.topCards).toEqual([]);
    expect(out.body.topRarities).toEqual([]);
    // The page itself still renders.
    expect(out.body.pulls).toHaveLength(3);
  });

  it('combines ?customer_id= with ?source=', async () => {
    const { res } = mkRes();
    const scope = mkScope(3);
    await GET(
      { scope, query: { customer_id: 'cus_1', source: 'pack' } } as any,
      res,
    );
    expect(scope.seen.ledger).toEqual({ source: 'pack', customer_id: 'cus_1' });
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
    ['over-long', 'c'.repeat(65)],
    ['repeated param', ['cus_1', 'cus_2']],
  ])('rejects a %s ?customer_id=', async (_label, raw) => {
    const { res, out } = mkRes();
    const scope = mkScope(3);
    await GET({ scope, query: { customer_id: raw } } as any, res);
    expect(out.status).toBe(400);
    expect(out.body.message).toMatch(/customer_id/i);
    // Bailed before touching the ledger.
    expect(scope.seen.ledger).toBeUndefined();
  });
});
