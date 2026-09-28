import { GET, POST } from '../route';
import type {
  FakeFacet,
  GatewayDeposits,
} from '../../../../../../modules/packs/facets';

// The Meta Pixel's source of settled deposits and its ack. Pinned here: every
// read and write is scoped to the verified caller, "first" follows settlement
// order, and the ack can only flag the caller's own settled, unreported rows.

const listMock = jest.fn(async () => [] as unknown[]);
const updateMock = jest.fn(async () => [] as unknown[]);
const jsonMock = jest.fn();
const res = { json: jsonMock } as never;

const req = (over: Record<string, unknown> = {}) =>
  ({
    auth_context: { actor_id: 'cus_1' },
    scope: {
      resolve: () =>
        ({
          listGatewayDeposits: listMock,
          updateGatewayDeposits: updateMock,
        }) satisfies FakeFacet<GatewayDeposits>,
    },
    ...over,
  }) as never;

const settledRow = (id: string, ref: string, settled: number | null) => ({
  id,
  merchant_transaction_id: ref,
  gateway_transaction_id: 'D999',
  customer_id: 'cus_1',
  status: 'settled',
  amount_requested: 50,
  amount_settled: settled,
  payment_method_code: 'FPX',
  pixel_reported_at: null,
});

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue([]);
  updateMock.mockClear();
  jsonMock.mockClear();
});

describe('GET /store/credits/deposit/unreported', () => {
  it('lists only the caller’s settled, unreported deposits of the last week, oldest first', async () => {
    const before = Date.now();
    await GET(req(), res);
    const after = Date.now();

    const week = 7 * 24 * 60 * 60 * 1000;
    const [selector, config] = listMock.mock.calls[0] as unknown as [
      {
        customer_id: string;
        status: string;
        pixel_reported_at: null;
        settled_at: { $gte: Date };
      },
      { take: number; order: Record<string, string> },
    ];
    expect(selector.customer_id).toBe('cus_1');
    expect(selector.status).toBe('settled');
    expect(selector.pixel_reported_at).toBeNull();
    expect(selector.settled_at.$gte.getTime()).toBeGreaterThanOrEqual(
      before - week,
    );
    expect(selector.settled_at.$gte.getTime()).toBeLessThanOrEqual(
      after - week,
    );
    expect(config.order).toEqual({ settled_at: 'ASC', id: 'ASC' });
    expect(config.take).toBe(10);
  });

  it('skips the first-ever lookup when nothing is unreported', async () => {
    await GET(req(), res);
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(jsonMock).toHaveBeenCalledWith({ deposits: [] });
  });

  // First by SETTLEMENT (id breaks the sweep's shared instant), and the
  // credited figure with the requested one only as a fallback.
  it('flags the first ever settled deposit and reports the credited amount', async () => {
    listMock
      .mockResolvedValueOnce([
        settledRow('gpd_1', 'PC-1', null),
        settledRow('gpd_2', 'PC-2', 101),
      ])
      .mockResolvedValueOnce([]) // none of theirs reported yet
      .mockResolvedValueOnce([{ id: 'gpd_1' }]);

    await GET(req(), res);

    expect(listMock.mock.calls[1]).toEqual([
      {
        customer_id: 'cus_1',
        status: 'settled',
        pixel_reported_at: { $ne: null },
      },
      { take: 1, select: ['id'] },
    ]);
    expect(listMock.mock.calls[2]).toEqual([
      { customer_id: 'cus_1', status: 'settled' },
      { take: 1, order: { settled_at: 'ASC', id: 'ASC' }, select: ['id'] },
    ]);
    expect(jsonMock).toHaveBeenCalledWith({
      deposits: [
        { merchant_transaction_id: 'PC-1', amount: 50, first: true },
        { merchant_transaction_id: 'PC-2', amount: 101, first: false },
      ],
    });
  });

  // Once one of the customer's deposits has been reported, "first" is spoken
  // for: a deposit that commits later with an earlier settled_at (the sweep
  // stamps its start instant) must not become a second FirstDeposit.
  it('never flags a first once any of the customer’s deposits was reported', async () => {
    listMock
      .mockResolvedValueOnce([settledRow('gpd_0', 'PC-0', 40)])
      .mockResolvedValueOnce([{ id: 'gpd_2' }]); // already reported

    await GET(req(), res);

    expect(listMock).toHaveBeenCalledTimes(2);
    expect(jsonMock).toHaveBeenCalledWith({
      deposits: [{ merchant_transaction_id: 'PC-0', amount: 40, first: false }],
    });
  });

  it('refuses a request with no verified customer instead of matching everyone', async () => {
    await expect(
      GET(req({ auth_context: { actor_id: '' } }), res),
    ).rejects.toThrow(/unauthorized/i);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('ignores a caller-supplied customer id', async () => {
    await GET(
      req({
        query: { customer_id: 'cus_victim' },
        body: { customer_id: 'cus_victim' },
      }),
      res,
    );
    const [selector] = listMock.mock.calls[0] as unknown as [
      { customer_id: string },
    ];
    expect(selector.customer_id).toBe('cus_1');
  });
});

describe('POST /store/credits/deposit/unreported (ack)', () => {
  it('flags only the caller’s own settled, unreported rows among the references', async () => {
    listMock.mockResolvedValueOnce([{ id: 'gpd_1' }, { id: 'gpd_2' }]);

    await POST(
      req({
        body: { references: ['PC-1', 'PC-2', 'PC-foreign'], customer_id: 'x' },
      }),
      res,
    );

    expect(listMock).toHaveBeenCalledWith(
      {
        customer_id: 'cus_1',
        status: 'settled',
        pixel_reported_at: null,
        merchant_transaction_id: ['PC-1', 'PC-2', 'PC-foreign'],
      },
      { take: 10, select: ['id'] },
    );
    const [updates] = updateMock.mock.calls[0] as unknown as [
      { id: string; pixel_reported_at: Date }[],
    ];
    expect(updates.map((u) => u.id)).toEqual(['gpd_1', 'gpd_2']);
    expect(updates[0].pixel_reported_at).toBeInstanceOf(Date);
    expect(jsonMock).toHaveBeenCalledWith({ acknowledged: 2 });
  });

  it('writes nothing when no reference matches', async () => {
    await POST(req({ body: { references: ['PC-unknown'] } }), res);
    expect(updateMock).not.toHaveBeenCalled();
    expect(jsonMock).toHaveBeenCalledWith({ acknowledged: 0 });
  });

  it.each([
    ['no body', undefined],
    ['not an array', { references: 'PC-1' }],
    ['empty', { references: [] }],
    [
      'too many',
      { references: Array.from({ length: 11 }, (_, i) => `PC-${i}`) },
    ],
    ['a non-string', { references: ['PC-1', 7] }],
    ['an empty string', { references: [''] }],
  ])('rejects %s', async (_label, body) => {
    await expect(POST(req({ body }), res)).rejects.toThrow(/references/);
    expect(listMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('refuses a request with no verified customer', async () => {
    await expect(
      POST(
        req({ auth_context: undefined, body: { references: ['PC-1'] } }),
        res,
      ),
    ).rejects.toThrow(/unauthorized/i);
    expect(listMock).not.toHaveBeenCalled();
  });
});
