import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { GET as history } from '../route';
import { paidPerOpen } from '../../../../../modules/packs/pull-history';

// The customer's pull history: every pull of the CALLER (customer id from the
// token only), any status, with what each card cost (the open's charge split
// over its paid pulls) and what it sold for.
const mkRes = () => {
  const out: { body?: unknown } = {};
  return {
    res: { json: (b: unknown) => (out.body = b) } as unknown as MedusaResponse,
    out,
  };
};

const listPulls = jest.fn();
const listCards = jest.fn();
const listPacks = jest.fn();
const listPackOdds = jest.fn();
const listCreditTransactions = jest.fn();
const listFxRates = jest.fn();

const mkReq = (customerId = 'cus_1', query: Record<string, unknown> = {}) => ({
  auth_context: { actor_id: customerId },
  query,
  params: {},
  scope: {
    resolve: () => ({
      listPulls,
      listCards,
      listPacks,
      listPackOdds,
      listCreditTransactions,
      listFxRates,
    }),
  },
});

const at = new Date('2026-10-20T10:00:00.000Z');
const pull = (over: Record<string, unknown>) => ({
  id: 'pull_x',
  customer_id: 'cus_1',
  pack_id: 'bronze',
  card_id: 'charizard',
  rolled_at: at,
  status: 'vaulted',
  source: 'pack',
  open_id: null,
  recorded_value_usd: null,
  buyback_amount: null,
  buyback_at: null,
  ...over,
});

beforeEach(() => {
  for (const f of [
    listPulls,
    listCards,
    listPacks,
    listPackOdds,
    listCreditTransactions,
  ])
    f.mockReset().mockResolvedValue([]);
  listFxRates
    .mockReset()
    .mockResolvedValue([
      { rate: 4, manual_override: false, manual_rate: null },
    ]);
  listCards.mockResolvedValue([
    {
      handle: 'charizard',
      name: 'Charizard ex',
      set: 'SV',
      grader: 'PSA',
      grade: '10',
      market_value: 25,
      market_multiplier: 1,
      image: '/c.png',
      slab_image: null,
    },
  ]);
  listPacks.mockResolvedValue([{ slug: 'bronze', title: 'Bronze Pack' }]);
});

describe('GET /store/pulls/history', () => {
  it("lists the caller's own pulls of every status, newest first, one extra for has_more", async () => {
    const { res, out } = mkRes();
    await history(
      mkReq('cus_me', {
        customer_id: 'cus_victim',
      }) as unknown as AuthenticatedMedusaRequest,
      res,
    );

    expect(listPulls).toHaveBeenCalledWith(
      { customer_id: 'cus_me' },
      { order: { rolled_at: 'DESC', id: 'DESC' }, take: 21, skip: 0 },
    );
    expect(out.body).toEqual({ items: [], has_more: false });
  });

  it('pages with ?limit/offset and reports has_more from the extra row', async () => {
    listPulls.mockResolvedValueOnce([
      pull({ id: 'p1' }),
      pull({ id: 'p2' }),
      pull({ id: 'p3' }),
    ]);
    const { res, out } = mkRes();
    await history(
      mkReq('cus_1', {
        limit: '2',
        offset: '4',
      }) as unknown as AuthenticatedMedusaRequest,
      res,
    );

    expect(listPulls).toHaveBeenCalledWith(
      { customer_id: 'cus_1' },
      expect.objectContaining({ take: 3, skip: 4 }),
    );
    const body = out.body as {
      items: { pull_id: string }[];
      has_more: boolean;
    };
    expect(body.items.map((i) => i.pull_id)).toEqual(['p1', 'p2']);
    expect(body.has_more).toBe(true);
  });

  it('prices a sold card from its batch charge and states the sale', async () => {
    const sold = pull({
      id: 'p_sold',
      open_id: 'open_1',
      status: 'bought_back',
      recorded_value_usd: 20,
      buyback_amount: '72.00',
      buyback_at: at,
    });
    // The page holds one pull of the open; the open had two paid rows and a
    // gifted one (charged nothing) — RM 90 / 2 paid rows = RM 45 per card.
    listPulls.mockResolvedValueOnce([sold]).mockResolvedValueOnce([
      { id: 'p_sold', open_id: 'open_1', source: 'pack' },
      { id: 'p_b', open_id: 'open_1', source: 'pack' },
      { id: 'p_g', open_id: 'open_1', source: 'gift' },
    ]);
    listCreditTransactions.mockResolvedValue([
      { source_transaction_id: 'open_1', amount: -90 },
    ]);
    const { res, out } = mkRes();
    await history(mkReq() as unknown as AuthenticatedMedusaRequest, res);

    expect(listCreditTransactions).toHaveBeenCalledWith(
      {
        customer_id: 'cus_1',
        reason: 'pack_open',
        source_transaction_id: ['open_1'],
      },
      expect.anything(),
    );
    expect(listPulls).toHaveBeenLastCalledWith(
      { customer_id: 'cus_1', open_id: ['open_1'] },
      expect.objectContaining({ select: ['id', 'open_id', 'source'] }),
    );
    const [item] = (out.body as { items: Record<string, unknown>[] }).items;
    expect(item).toMatchObject({
      pull_id: 'p_sold',
      pack_title: 'Bronze Pack',
      status: 'bought_back',
      paid: 45,
      value: 80, // draw-time USD 20 × FX 4, not today's USD 25
      sold_for: 72,
      sold_at: at,
      card: { name: 'Charizard ex', marketPriceMyr: 100 },
    });
  });

  it('leaves the price unknown where no charge links to the pull, and names reward packs', async () => {
    listPulls.mockResolvedValueOnce([
      pull({ id: 'p_old' }), // pre-2a: no open_id
      pull({ id: 'p_task', source: 'reward', pack_id: 'task-reward' }),
    ]);
    const { res, out } = mkRes();
    await history(mkReq() as unknown as AuthenticatedMedusaRequest, res);

    const items = (out.body as { items: Record<string, unknown>[] }).items;
    expect(items[0]).toMatchObject({ paid: null, value: 100, sold_for: null });
    expect(items[1]).toMatchObject({
      paid: null,
      pack_title: 'Task reward',
      source: 'reward',
    });
    expect(listCreditTransactions).not.toHaveBeenCalled();
  });

  it('names a Lucky Draw card and gives it no tier, even one a live pack holds', async () => {
    listPackOdds.mockResolvedValue([
      { pack_id: 'bronze', card_id: 'charizard', rarity: 'Legendary' },
    ]);
    listPulls.mockResolvedValueOnce([
      pull({ id: 'p_pack' }),
      pull({ id: 'p_ld', source: 'reward', pack_id: 'lucky-draw' }),
    ]);
    const { res, out } = mkRes();
    await history(mkReq() as unknown as AuthenticatedMedusaRequest, res);

    const items = (out.body as { items: Record<string, unknown>[] }).items;
    expect(items[0]).toMatchObject({
      lucky_draw_prize: false,
      card: { rarity: 'Legendary' },
    });
    expect(items[1]).toMatchObject({
      pack_title: 'Lucky Draw',
      lucky_draw_prize: true,
      challenge_prize: false,
      card: { rarity: '' },
    });
  });

  it('keeps a pull whose card was since deleted, with its money trail', async () => {
    listPulls.mockResolvedValueOnce([
      pull({
        id: 'p_gone',
        card_id: 'retired',
        status: 'bought_back',
        recorded_value_usd: 20,
        buyback_amount: 72,
        buyback_at: at,
      }),
    ]);
    const { res, out } = mkRes();
    await history(mkReq() as unknown as AuthenticatedMedusaRequest, res);

    const [item] = (out.body as { items: Record<string, unknown>[] }).items;
    expect(item).toMatchObject({
      pull_id: 'p_gone',
      card: { handle: '', name: 'Retired card', marketPriceMyr: null },
      value: 80,
      sold_for: 72,
    });
  });
});

describe('paidPerOpen', () => {
  it('splits the debit over paid rows only and ignores reversals', () => {
    const out = paidPerOpen(
      [
        { source_transaction_id: 'o1', amount: -100 },
        { source_transaction_id: 'o1', amount: 100 }, // reversal row
        { source_transaction_id: 'o2', amount: -45 },
      ],
      [
        { open_id: 'o1', source: 'pack' },
        { open_id: 'o1', source: 'bonus' },
        { open_id: 'o1', source: 'pack' },
        { open_id: 'o2', source: 'gift' },
      ],
    );
    expect(out.get('o1')).toBe(33.33);
    // An open whose only pulls were gifts has no paid row to split over.
    expect(out.has('o2')).toBe(false);
  });
});
