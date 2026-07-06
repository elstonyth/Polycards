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
  const packs = {
    listPulls: async (_f: any, o: any) => all.slice(0, o?.take ?? all.length),
    listAndCountPulls: async (_f: any, o: any) => [
      all.slice(o?.skip ?? 0, (o?.skip ?? 0) + (o?.take ?? 50)),
      all.length,
    ],
    listCards: async () => [
      { handle: 'card-a', name: 'Card A', market_value: 10, image: 'x.png' },
    ],
    listPackOdds: async () => [],
    listPacks: async () => [{ id: 'pack_1', title: 'Starter Pack' }],
    listFxRates: async () => [],
  };
  return {
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
});
