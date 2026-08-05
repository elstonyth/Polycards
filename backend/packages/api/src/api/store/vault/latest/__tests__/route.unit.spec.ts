import { GET as latest } from '../route';

// The route's whole job is: read the caller's own newest vault-visible pull.
// This spec pins the three things that make it correct — the customer id comes
// from the verified token (never params/query), the status filter is present
// (it is what keeps sell-backs and ship-outs from lighting the dot), and an
// empty vault answers null rather than omitting the key.
const mkRes = () => {
  const out: { body?: unknown; headers: Record<string, string> } = {
    headers: {},
  };
  return {
    res: {
      json: (b: unknown) => (out.body = b),
      setHeader: (k: string, v: string) => (out.headers[k] = v),
    } as never,
    out,
  };
};

const listPulls = jest.fn();

const mkReq = (customerId = 'cus_1') => ({
  auth_context: { actor_id: customerId },
  query: {},
  params: {},
  scope: { resolve: () => ({ listPulls }) },
});

beforeEach(() => {
  listPulls.mockReset().mockResolvedValue([]);
});

describe('GET /store/vault/latest', () => {
  it("reads only the caller's own vaulted pulls, newest first, one row", async () => {
    const { res, out } = mkRes();

    await latest(mkReq('cus_me') as never, res);

    expect(listPulls).toHaveBeenCalledWith(
      { customer_id: 'cus_me', status: 'vaulted' },
      { order: { updated_at: 'DESC' }, take: 1 },
    );
    expect(out.body).toEqual({ latest_event_at: null });
  });

  it('returns the newest row updated_at when the vault is not empty', async () => {
    const when = new Date('2026-08-05T10:00:00.000Z');
    listPulls.mockResolvedValue([{ id: 'pull_1', updated_at: when }]);
    const { res, out } = mkRes();

    await latest(mkReq() as never, res);

    expect(out.body).toEqual({ latest_event_at: when });
  });

  it('ignores a customer id supplied in params or query (IDOR)', async () => {
    const req = {
      ...mkReq('cus_me'),
      params: { customer_id: 'cus_victim' },
      query: { customer_id: 'cus_victim' },
    };
    const { res } = mkRes();

    await latest(req as never, res);

    expect(listPulls).toHaveBeenCalledWith(
      expect.objectContaining({ customer_id: 'cus_me' }),
      expect.anything(),
    );
  });
});
