import { GET as getTransactions } from '../transactions/route';
import { GET as getPulls } from '../pulls/route';

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

const tx = (i: number) => ({
  id: `ctx_${i}`,
  amount: -5,
  reason: 'pack_open',
  reference: null,
  created_at: new Date(2026, 0, i + 1),
});
const pull = (i: number) => ({
  id: `pull_${i}`,
  pack_id: 'pack_1',
  card_id: 'card-a',
  rolled_at: new Date(2026, 0, i + 1),
  status: 'vaulted',
  buyback_amount: null,
});

// `seen.pulls` records the filter the pulls route actually queried with — the
// ?status=/?source= cases assert those land in the filter, not just in a 200.
const seen: { pulls?: any } = {};

function mkScope() {
  const txs = Array.from({ length: 60 }, (_, i) => tx(i));
  const pulls = Array.from({ length: 60 }, (_, i) => pull(i));
  seen.pulls = undefined;
  return {
    resolve: () => ({
      listAndCountCreditTransactions: async (_f: any, o: any) => [
        txs.slice(o?.skip ?? 0, (o?.skip ?? 0) + (o?.take ?? 25)),
        txs.length,
      ],
      listAndCountPulls: async (f: any, o: any) => {
        seen.pulls = f;
        return [
          pulls.slice(o?.skip ?? 0, (o?.skip ?? 0) + (o?.take ?? 25)),
          pulls.length,
        ];
      },
      listCards: async () => [
        { handle: 'card-a', name: 'Card A', market_value: 10, image: 'x.png' },
      ],
      listPacks: async () => [{ slug: 'pack_1', buyback_percent: 95 }],
      listFxRates: async () => [],
    }),
  };
}

describe('customer history pagination', () => {
  it('transactions: pages and reports total', async () => {
    const { res, out } = mkRes();
    await getTransactions(
      {
        scope: mkScope(),
        params: { id: 'cus_1' },
        query: { limit: '25', offset: '25' },
      } as any,
      res,
    );
    expect(out.body.total).toBe(60);
    expect(out.body.items).toHaveLength(25);
  });

  it('pulls: pages, reports total, joins card', async () => {
    const { res, out } = mkRes();
    await getPulls(
      { scope: mkScope(), params: { id: 'cus_1' }, query: {} } as any,
      res,
    );
    expect(out.body.total).toBe(60);
    expect(out.body.items[0].card?.name).toBe('Card A');
  });

  it('pulls: surfaces quote-vs-payable for the dispute desk (sim P1-3)', async () => {
    const { res, out } = mkRes();
    await getPulls(
      { scope: mkScope(), params: { id: 'cus_1' }, query: {} } as any,
      res,
    );
    // listFxRates is empty in the mock scope → display fallback, NOT firm:
    // the desk must see that customer-facing quotes are currently refusable.
    expect(out.body.fx).toEqual({ rate: 4.7, firm: false });
    const item = out.body.items[0];
    // Vaulted card pull rolled far outside the instant window → flat rate,
    // amount = displayMarketPrice(10 USD × 4.7 × 1.2 default multiplier) × 90%.
    expect(item.quote).toEqual({
      percent: 90,
      amount: 50.76,
      rate_type: 'vault',
      firm: false,
      instant_deadline_ms: expect.any(Number),
    });
    expect(item.buyback_at).toBeNull();
  });

  // Player tab filters: "show me only what's still in their vault" / "only
  // pack pulls". The customer scope always stays on the filter.
  it('pulls: ?status= and ?source= narrow the query', async () => {
    const { res, out } = mkRes();
    await getPulls(
      {
        scope: mkScope(),
        params: { id: 'cus_1' },
        query: { status: 'vaulted', source: 'pack' },
      } as any,
      res,
    );
    expect(seen.pulls).toEqual({
      customer_id: 'cus_1',
      status: 'vaulted',
      source: 'pack',
    });
    expect(out.status).toBeUndefined();
  });

  it('pulls: rejects an unknown ?status=', async () => {
    const { res, out } = mkRes();
    await getPulls(
      {
        scope: mkScope(),
        params: { id: 'cus_1' },
        // The DELIVERY enum is a different set — a delivery status here is
        // just as invalid as gibberish.
        query: { status: 'shipped' },
      } as any,
      res,
    );
    expect(out.status).toBe(400);
    expect(out.body.message).toMatch(/status/i);
    expect(seen.pulls).toBeUndefined();
  });

  it('pulls: rejects an unknown ?source=', async () => {
    const { res, out } = mkRes();
    await getPulls(
      {
        scope: mkScope(),
        params: { id: 'cus_1' },
        query: { source: 'bogus' },
      } as any,
      res,
    );
    expect(out.status).toBe(400);
    expect(out.body.message).toMatch(/source/i);
    expect(seen.pulls).toBeUndefined();
  });
});
