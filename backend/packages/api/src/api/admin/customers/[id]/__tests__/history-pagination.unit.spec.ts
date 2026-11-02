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
  source_transaction_id: `open_${i}`,
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
const seen: { pulls?: any; listPulls: any[]; balanceArgs?: any[] } = {
  listPulls: [],
};

// `hasPaid` is the customer's hasPaidOpen() — behind lockedPullIds, the
// free-welcome lock the pulls route reads so its payable-now quote refuses
// exactly where the customer's sell button does.
function mkScope(
  opts: {
    hasPaid?: boolean;
    rows?: any[];
    txs?: any[];
    spins?: any[];
    noOpenPulls?: boolean;
  } = {},
) {
  const txs = opts.txs ?? Array.from({ length: 60 }, (_, i) => tx(i));
  const pulls = opts.rows ?? Array.from({ length: 60 }, (_, i) => pull(i));
  seen.pulls = undefined;
  seen.listPulls = [];
  seen.balanceArgs = undefined;
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
      listPacks: async () => [
        { slug: 'pack_1', title: 'Gold Pack', buyback_percent: 95 },
      ],
      listFxRates: async () => [],
      // Honours its filter, so a row can only get the pull that is really its.
      listPulls: async (f: any) => {
        seen.listPulls.push(f);
        if (f.open_id) {
          return opts.noOpenPulls
            ? []
            : f.open_id.map((open_id: string, i: number) => ({
                ...pull(i),
                open_id,
              }));
        }
        return f.id.map((id: string) => ({ ...pull(0), id }));
      },
      listTicketSpins: async () => opts.spins ?? [],
      listLedgerEntries: async () => [],
      balanceAfterRows: async (...args: any[]) => {
        seen.balanceArgs = args;
        return new Map([['ctx_0', 95.5]]);
      },
      listPackOdds: async () => [
        { pack_id: 'pack_1', card_id: 'card-a', rarity: 'Rare' },
      ],
      listDeliveryOrderItems: async () => [
        // Canceled LAST: a Map keeps the last entry, so with no filter on the
        // order's status this row would win and the test would fail.
        { pull_id: 'pull_0', delivery_order_id: 'live' },
        { pull_id: 'pull_0', delivery_order_id: 'canceled' },
      ],
      listDeliveryOrders: async () => [
        { id: 'canceled', status: 'canceled' },
        { id: 'live', status: 'shipped' },
      ],
      lockedPullIds: async (_id: string, rows: any[]) =>
        new Set(
          (opts.hasPaid ?? true)
            ? []
            : rows.filter((r) => r.source === 'free').map((r) => r.id),
        ),
      // No Lossless window: quotes stay at the pack's own rate.
      losslessWindows: async () => [],
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

  it('transactions: says what each row was about', async () => {
    const { res, out } = mkRes();
    await getTransactions(
      { scope: mkScope(), params: { id: 'cus_1' }, query: {} } as any,
      res,
    );
    expect(out.body.items[0]).toMatchObject({
      balance_after: 95.5,
      pack_title: 'Gold Pack',
      cards: [{ pull_id: 'pull_0', name: 'Card A', image: 'x.png' }],
      order_id: null,
    });
    // Each row gets its own open's pull, not the first one read.
    expect(out.body.items[1].cards).toEqual([
      expect.objectContaining({ pull_id: 'pull_1' }),
    ]);
    // Never another customer's pulls, and the balance of this page's rows.
    expect(seen.listPulls.every((f) => f.customer_id === 'cus_1')).toBe(true);
    expect(seen.balanceArgs?.[0]).toBe('cus_1');
    expect(seen.balanceArgs?.[1]).toHaveLength(25);
  });

  it('transactions: a sell-back names its own card', async () => {
    const { res, out } = mkRes();
    await getTransactions(
      {
        scope: mkScope({
          txs: [
            {
              id: 'ctx_b',
              amount: 5,
              reason: 'buyback',
              pull_id: 'pull_9',
              created_at: new Date(2026, 0, 1),
            },
          ],
        }),
        params: { id: 'cus_1' },
        query: {},
      } as any,
      res,
    );
    expect(out.body.items[0].cards).toEqual([
      expect.objectContaining({ pull_id: 'pull_9' }),
    ]);
  });

  it('transactions: a shipping fee and its refund name the order', async () => {
    const fee = (id: string, amount: number, reference: string) => ({
      id,
      amount,
      reason: 'delivery_fee',
      reference,
      created_at: new Date(2026, 0, 1),
    });
    const { res, out } = mkRes();
    await getTransactions(
      {
        scope: mkScope({
          txs: [fee('ctx_f', -15, 'do_9'), fee('ctx_r', 15, 'refund:do_9')],
        }),
        params: { id: 'cus_1' },
        query: {},
      } as any,
      res,
    );
    expect(out.body.items.map((t: any) => t.order_id)).toEqual([
      'do_9',
      'do_9',
    ]);
  });

  it('transactions: a ticket pack names its pack with no card', async () => {
    const { res, out } = mkRes();
    await getTransactions(
      {
        scope: mkScope({
          noOpenPulls: true,
          spins: [{ open_id: 'open_0', pack_id: 'pack_1' }],
        }),
        params: { id: 'cus_1' },
        query: {},
      } as any,
      res,
    );
    expect(out.body.items[0]).toMatchObject({
      pack_title: 'Gold Pack',
      cards: [],
    });
    expect(out.body.items[1].pack_title).toBeNull();
  });

  it('pulls: names the live order of a shipped card, never a canceled one', async () => {
    const { res, out } = mkRes();
    await getPulls(
      {
        scope: mkScope({ rows: [{ ...pull(0), status: 'delivering' }] }),
        params: { id: 'cus_1' },
        query: {},
      } as any,
      res,
    );
    expect(out.body.items[0].order_id).toBe('live');
    expect(out.body.items[0].card.rarity).toBe('Rare');
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

  // The desk must not be quoted a price the customer cannot take: a free
  // welcome pull is unsellable until the first PAID open, so its payable-now
  // quote appears only once hasPaidOpen() is true (spec 2026-08-14).
  it('pulls: a locked free pull carries no payable-now quote', async () => {
    const rows = [{ ...pull(0), source: 'free' }];

    const locked = mkRes();
    await getPulls(
      {
        scope: mkScope({ hasPaid: false, rows }),
        params: { id: 'cus_1' },
        query: {},
      } as any,
      locked.res,
    );
    expect(locked.out.body.items[0].quote).toBeNull();

    const unlocked = mkRes();
    await getPulls(
      {
        scope: mkScope({ hasPaid: true, rows }),
        params: { id: 'cus_1' },
        query: {},
      } as any,
      unlocked.res,
    );
    expect(unlocked.out.body.items[0].quote).not.toBeNull();
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
