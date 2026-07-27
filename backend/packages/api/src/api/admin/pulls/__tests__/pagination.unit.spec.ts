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

const pull = (i: number) => ({
  id: `pull_${i}`,
  rolled_at: new Date(2026, 0, i + 1),
  customer_id: 'cus_1',
  pack_id: 'pack_1',
  card_id: 'card-a',
  status: 'vaulted',
  buyback_amount: null,
});

function mkScope(totalPulls: number) {
  const all = Array.from({ length: totalPulls }, (_, i) => pull(i));
  // Filters each list call actually received — the ?source= tests assert the
  // ledger is filtered while the rollup window stays global.
  const seen: { rollup?: any; ledger?: any } = {};
  const packs = {
    listPulls: async (f: any, o: any) => {
      seen.rollup = f;
      return all.slice(0, o?.take ?? all.length);
    },
    listAndCountPulls: async (f: any, o: any) => {
      seen.ledger = f;
      return [
        all.slice(o?.skip ?? 0, (o?.skip ?? 0) + (o?.take ?? 50)),
        all.length,
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

  it('leaves the rollup window unfiltered when ?source= is set', async () => {
    const { res } = mkRes();
    const scope = mkScope(3);
    await GET({ scope, query: { source: 'pack' } } as any, res);
    // Rollups are global stats, not a view of the current page.
    expect(scope.seen.rollup).toEqual({});
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
});
