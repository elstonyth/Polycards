import { GET } from '../route';

const packs = { visitorSignalMatches: jest.fn() };
const customers = { listCustomers: jest.fn() };
const scope = {
  resolve: (key: string) => (key === 'packs' ? packs : customers),
};
const mkReq = () => ({ params: { id: 'cus_1' }, scope }) as never;
const mkRes = () => ({ json: jest.fn(), setHeader: jest.fn() });

beforeEach(() => jest.clearAllMocks());

describe('GET visitor-signals', () => {
  it('names the other accounts, once each lookup, and never caches', async () => {
    packs.visitorSignalMatches.mockResolvedValue({
      recorded: true,
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
    expect(res.json).toHaveBeenCalledWith({
      recorded: true,
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
      device: [],
      ip: [],
    });
    const res = mkRes();
    await GET(mkReq(), res as never);
    expect(customers.listCustomers).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      recorded: false,
      device: [],
      ip: [],
    });
  });
});
