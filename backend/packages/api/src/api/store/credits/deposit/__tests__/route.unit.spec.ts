import { POST, GET } from '../route';
import { GLOBEPAY_STALE_AFTER_MS } from '../../../../../modules/packs/globepay-reconcile';

// The IP we send as GlobePay365's `IPAddress` must be the one the proxy chain
// derived, not one the caller typed. Medusa's express-loader sets
// `trust proxy` 1 unconditionally, so req.ip is that value; a raw
// X-Forwarded-For header is attacker-controlled and only a fallback.
jest.mock('../../../../../modules/packs/globepay-deposit', () => ({
  startGlobePayDeposit: jest.fn(async () => ({ url: 'https://cashier/x' })),
}));

import { startGlobePayDeposit } from '../../../../../modules/packs/globepay-deposit';

const startMock = startGlobePayDeposit as jest.Mock;

const res = { json: jest.fn() } as never;

const mkReq = (over: Record<string, unknown> = {}) =>
  ({
    auth_context: { actor_id: 'cus_1' },
    body: { amount: 50 },
    headers: {},
    scope: {},
    socket: {},
    ...over,
  }) as never;

const sentIp = () => startMock.mock.calls[0][1].ipAddress;

const ORIGINAL_ENV = {
  GLOBEPAY_NOTIFY_URL: process.env.GLOBEPAY_NOTIFY_URL,
  GLOBEPAY_RETURN_URL: process.env.GLOBEPAY_RETURN_URL,
};

beforeEach(() => {
  startMock.mockClear();
  process.env.GLOBEPAY_NOTIFY_URL = 'https://us/hooks/globepay/deposit';
  process.env.GLOBEPAY_RETURN_URL = 'https://us/return';
});

// These are process-wide: leaving them set leaks into whatever runs next and
// makes a later suite pass or fail on execution order.
afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('POST /store/credits/deposit — customer IP', () => {
  it('prefers req.ip over a spoofable X-Forwarded-For', async () => {
    await POST(
      mkReq({
        ip: '203.0.113.7',
        headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
        socket: { remoteAddress: '10.0.0.1' },
      }),
      res,
    );
    expect(sentIp()).toBe('203.0.113.7');
  });

  it('falls back to the forwarded first hop, then the socket, then 0.0.0.0', async () => {
    await POST(
      mkReq({ headers: { 'x-forwarded-for': ' 1.2.3.4 , 5.6.7.8' } }),
      res,
    );
    expect(sentIp()).toBe('1.2.3.4');

    startMock.mockClear();
    await POST(mkReq({ socket: { remoteAddress: '10.0.0.1' } }), res);
    expect(sentIp()).toBe('10.0.0.1');

    startMock.mockClear();
    await POST(mkReq(), res);
    expect(sentIp()).toBe('0.0.0.0');
  });

  // The header type permits string[] — Node's parser comma-joins repeats and
  // never emits one, but middleware could assign one. Stringifying it would
  // send the gateway '[object Object]' as an IP address.
  it('ignores an array X-Forwarded-For instead of stringifying it', async () => {
    await POST(
      mkReq({
        headers: { 'x-forwarded-for': ['1.2.3.4', '5.6.7.8'] },
        socket: { remoteAddress: '10.0.0.1' },
      }),
      res,
    );
    expect(sentIp()).toBe('10.0.0.1');
  });

  // Either URL missing must fail closed. Covering only NOTIFY would let a
  // dropped RETURN guard through — money in, no credit, no test.
  it.each(['GLOBEPAY_NOTIFY_URL', 'GLOBEPAY_RETURN_URL'] as const)(
    'fails closed when %s is unset — money in, no credit',
    async (missing) => {
      delete process.env[missing];
      await expect(POST(mkReq({ ip: '203.0.113.7' }), res)).rejects.toThrow(
        /temporarily unavailable/i,
      );
      expect(startMock).not.toHaveBeenCalled();
    },
  );
});

describe('GET /store/credits/deposit — in-flight deposits', () => {
  const listMock = jest.fn(async () => [] as unknown[]);
  const jsonMock = jest.fn();
  const getRes = { json: jsonMock } as never;
  const getReq = (actorId = 'cus_1', over: Record<string, unknown> = {}) =>
    ({
      auth_context: { actor_id: actorId },
      scope: { resolve: () => ({ listGlobePayDeposits: listMock }) },
      ...over,
    }) as never;

  beforeEach(() => {
    listMock.mockClear();
    jsonMock.mockClear();
  });

  it('selects only the caller’s own pending deposits, inside the stale window', async () => {
    const before = Date.now();
    await GET(getReq(), getRes);
    const after = Date.now();

    const [selector, config] = listMock.mock.calls[0] as unknown as [
      { customer_id: string; status: string; created_at: { $gte: Date } },
      { take: number; order: Record<string, string> },
    ];
    expect(selector.customer_id).toBe('cus_1');
    expect(selector.status).toBe('pending');
    // The floor is the sweep's own window, so the page can never claim to be
    // confirming a deposit the sweep has already stopped chasing.
    expect(selector.created_at.$gte.getTime()).toBeGreaterThanOrEqual(
      before - GLOBEPAY_STALE_AFTER_MS,
    );
    expect(selector.created_at.$gte.getTime()).toBeLessThanOrEqual(
      after - GLOBEPAY_STALE_AFTER_MS,
    );
    expect(config.order).toEqual({ created_at: 'DESC' });
    expect(config.take).toBeGreaterThan(0);
  });

  // The IDOR guard. A query/body customer_id must be inert: the only id that
  // may reach the selector is the one the verified token carries.
  it('ignores a caller-supplied customer id', async () => {
    await GET(
      getReq('cus_1', {
        query: { customer_id: 'cus_victim' },
        body: { customer_id: 'cus_victim' },
      }),
      getRes,
    );
    const [selector] = listMock.mock.calls[0] as unknown as [
      { customer_id: string },
    ];
    expect(selector.customer_id).toBe('cus_1');
  });

  // The requested amount, never the gateway id or our internal status — the
  // response is what the customer may see, not the row.
  it('returns the requested amount and reference, and nothing else', async () => {
    const createdAt = new Date('2026-08-11T07:00:00.000Z');
    listMock.mockResolvedValueOnce([
      {
        id: 'gpd_1',
        merchant_transaction_id: 'PC-abc',
        gateway_transaction_id: 'D123',
        customer_id: 'cus_1',
        status: 'pending',
        amount_requested: 500,
        amount_settled: null,
        payment_method_code: 'BQR',
        created_at: createdAt,
      },
    ]);

    await GET(getReq(), getRes);

    expect(jsonMock).toHaveBeenCalledWith({
      deposits: [
        {
          merchant_transaction_id: 'PC-abc',
          amount: 500,
          payment_method_code: 'BQR',
          created_at: createdAt,
        },
      ],
    });
  });
});
