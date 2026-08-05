import { GET as latest } from '../route';

// The route's whole job is: read the caller's own newest ledger row. This spec
// pins the three things that make it correct — the customer id comes from the
// verified token (never params/query), the ordering is on created_at (a ledger
// row is append-only; a later bookkeeping touch is not new news), and an empty
// ledger answers null rather than omitting the key.
const mkRes = () => {
  const out: { body?: unknown } = {};
  return { res: { json: (b: unknown) => (out.body = b) } as never, out };
};

const listCreditTransactions = jest.fn();

const mkReq = (customerId = 'cus_1') => ({
  auth_context: { actor_id: customerId },
  query: {},
  params: {},
  scope: { resolve: () => ({ listCreditTransactions }) },
});

beforeEach(() => {
  listCreditTransactions.mockReset().mockResolvedValue([]);
});

describe('GET /store/credits/latest', () => {
  it("reads only the caller's own ledger, newest first, one row", async () => {
    const { res, out } = mkRes();

    await latest(mkReq('cus_me') as never, res);

    expect(listCreditTransactions).toHaveBeenCalledWith(
      { customer_id: 'cus_me' },
      { order: { created_at: 'DESC' }, take: 1 },
    );
    expect(out.body).toEqual({ latest_event_at: null });
  });

  it('returns the newest row created_at when the ledger is not empty', async () => {
    const when = new Date('2026-08-05T10:00:00.000Z');
    listCreditTransactions.mockResolvedValue([{ id: 'ct_1', created_at: when }]);
    const { res, out } = mkRes();

    await latest(mkReq() as never, res);

    expect(out.body).toEqual({ latest_event_at: when });
  });

  it('does not filter by direction — a debit is news too', async () => {
    // Money OUT is exactly what people open /transactions to verify. A filter
    // to credits only would silently drop spends and withdrawals.
    const { res } = mkRes();

    await latest(mkReq('cus_me') as never, res);

    const [filters] = listCreditTransactions.mock.calls[0];
    expect(Object.keys(filters)).toEqual(['customer_id']);
  });

  it('ignores a customer id supplied in params or query (IDOR)', async () => {
    const req = {
      ...mkReq('cus_me'),
      params: { customer_id: 'cus_victim' },
      query: { customer_id: 'cus_victim' },
    };
    const { res } = mkRes();

    await latest(req as never, res);

    expect(listCreditTransactions).toHaveBeenCalledWith(
      expect.objectContaining({ customer_id: 'cus_me' }),
      expect.anything(),
    );
  });
});
