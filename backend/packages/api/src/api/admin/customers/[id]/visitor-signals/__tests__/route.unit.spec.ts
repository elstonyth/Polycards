import { GET } from '../route';

const packs = {
  visitorSignalMatches: jest.fn(),
  createAdminActionAudits: jest.fn().mockResolvedValue(undefined),
};
const customers = { listCustomers: jest.fn() };
const scope = {
  resolve: (key: string) => (key === 'packs' ? packs : customers),
};
const mkReq = () =>
  ({
    params: { id: 'cus_1' },
    auth_context: { actor_id: 'user_1' },
    scope,
  }) as never;
const mkRes = () => ({ json: jest.fn(), setHeader: jest.fn() });

beforeEach(() => jest.clearAllMocks());

describe('GET visitor-signals', () => {
  it('names the other accounts, once each lookup, and never caches', async () => {
    packs.visitorSignalMatches.mockResolvedValue({
      recorded: true,
      unsigned: false,
      device_total: 1,
      ip_total: 1,
      device: [{ customer_id: 'cus_2', last_seen_at: '2026-11-03T00:00:00Z' }],
      ip: [
        { ip: '203.0.113.7', accounts: 12, customer_ids: ['cus_2', 'cus_3'] },
      ],
    });
    customers.listCustomers.mockResolvedValue([
      { id: 'cus_2', metadata: { handle: 'Collector2' } },
      { id: 'cus_3', metadata: {} },
    ]);
    const res = mkRes();
    await GET(mkReq(), res as never);
    expect(customers.listCustomers).toHaveBeenCalledWith(
      { id: ['cus_2', 'cus_3'] },
      expect.objectContaining({ take: 2 }),
    );
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    // A trail with counts only, never the addresses.
    const [[row]] = packs.createAdminActionAudits.mock.calls[0];
    expect(row).toMatchObject({
      action: 'reveal',
      admin_id: 'user_1',
      after: { same_browser: 1, same_network: 1 },
    });
    expect(JSON.stringify(row)).not.toContain('203.0.113.7');
    expect(res.json).toHaveBeenCalledWith({
      recorded: true,
      unsigned: false,
      device_total: 1,
      ip_total: 1,
      device: [
        {
          customer_id: 'cus_2',
          handle: 'Collector2',
          last_seen_at: '2026-11-03T00:00:00Z',
        },
      ],
      ip: [
        {
          ip: '203.0.113.7',
          accounts: 12,
          customers: [
            { customer_id: 'cus_2', handle: 'Collector2' },
            { customer_id: 'cus_3', handle: null },
          ],
        },
      ],
    });
  });

  it('skips the customer lookup when nothing matches', async () => {
    packs.visitorSignalMatches.mockResolvedValue({
      recorded: false,
      unsigned: false,
      device: [],
      device_total: 0,
      ip: [],
      ip_total: 0,
    });
    const res = mkRes();
    await GET(mkReq(), res as never);
    expect(customers.listCustomers).not.toHaveBeenCalled();
    expect(packs.createAdminActionAudits).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      recorded: false,
      unsigned: false,
      device_total: 0,
      ip_total: 0,
      device: [],
      ip: [],
    });
  });
});
