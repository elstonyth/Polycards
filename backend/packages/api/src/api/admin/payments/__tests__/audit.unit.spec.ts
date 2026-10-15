import { GET } from '../audit/route';
import { setActiveGateway } from '../../../../modules/packs/gateway';

const totals = {
  findings: 0,
  lastAuditedAt: null,
  deposits: {
    count: 0,
    grossCents: 0,
    netCents: 0,
    missingNet: 0,
    missingGross: 0,
  },
  withdrawals: {
    count: 0,
    grossCents: 0,
    netCents: 0,
    missingNet: 0,
    missingGross: 0,
  },
};

const row = (
  id: string,
  audited: string,
  over: Record<string, unknown> = {},
) => ({
  id,
  gateway: 'tgpay',
  merchant_transaction_id: `PC-${id}`,
  gateway_transaction_id: null,
  customer_id: 'cus_1',
  status: 'settled',
  amount: '10',
  amount_settled: '10',
  audit_note: 'gateway paid 10.06, row credited 10.00',
  audited_at: new Date(audited),
  ...over,
});

async function call(packs: Record<string, unknown>) {
  let body: { findings: { id: string }[] } | undefined;
  const req = {
    query: {},
    scope: {
      resolve: () => ({ gatewayAuditTotals: async () => totals, ...packs }),
    },
  };
  const res = {
    setHeader: () => undefined,
    json: (b: typeof body) => {
      body = b;
    },
  };
  await GET(req as never, res as never);
  return body!.findings.map((f) => f.id);
}

beforeEach(() => setActiveGateway('tgpay'));
afterAll(() => setActiveGateway(null));

describe('GET /admin/payments/audit findings', () => {
  // audited_at arrives as a Date: as a string it begins with the weekday, so
  // a string sort put Wednesday's findings above Thursday's.
  it('lists the newest audit first, by time', async () => {
    const ids = await call({
      listGatewayDeposits: async () => [
        row('tue', '2026-10-13T10:00:00Z'),
        row('wed', '2026-10-14T10:00:00Z'),
        row('thu', '2026-10-15T10:00:00Z'),
      ],
      listGatewayWithdrawals: async () => [],
    });
    expect(ids).toEqual(['thu', 'wed', 'tue']);
  });

  // The Dashboard counts "payout may be paid twice" from this list, so a
  // backlog of other findings must never push a refunded payout out of it.
  it('a refunded payout with a finding leads, however many others are newer', async () => {
    const others = Array.from({ length: 100 }, (_, i) =>
      row(`w${i}`, `2026-10-15T${String(i % 24).padStart(2, '0')}:00:00Z`, {
        audit_note: 'gateway paid out 10.06, row debited 10.00',
      }),
    );
    const risky = row('risky', '2026-10-01T00:00:00Z', {
      status: 'failed',
      audit_note: 'gateway still reports pending for a payout we refunded',
    });
    const filters: Record<string, unknown>[] = [];
    const ids = await call({
      listGatewayDeposits: async () => [],
      listGatewayWithdrawals: async (f: { status?: string }) => {
        filters.push(f);
        return f.status === 'failed' ? [risky] : others;
      },
    });
    expect(ids[0]).toBe('risky');
    // Acknowledged refunds are dealt with: they never take this list's room.
    expect(filters.find((f) => f.status === 'failed')).toMatchObject({
      audit_ack_at: null,
    });
    expect(ids).toHaveLength(100);
    expect(new Set(ids).size).toBe(100);
  });
});
