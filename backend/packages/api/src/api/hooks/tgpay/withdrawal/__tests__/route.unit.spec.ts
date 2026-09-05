jest.mock('../../../../../modules/packs/notify-feed', () => ({
  notifyFeed: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../../modules/packs/withdrawal-receipt', () => ({
  sendWithdrawalReceipt: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../../modules/packs/globepay-withdrawal', () => ({
  refundGlobePayWithdrawal: jest.fn().mockResolvedValue({ replayed: false }),
}));

import { POST } from '../route';
import { refundGlobePayWithdrawal } from '../../../../../modules/packs/globepay-withdrawal';

beforeEach(() => {
  process.env.TGPAY_API_BASE = 'https://sandbox-api.example.test/api/v2';
  process.env.TGPAY_PUBLIC_KEY = 'pk-test';
  process.env.TGPAY_SECRET_KEY = 'sk-test';
  (refundGlobePayWithdrawal as jest.Mock).mockClear();
});

const AUTH = { 'x-public-key': 'pk-test', 'x-secret-key': 'sk-test' };

const success = {
  transactionId: 'tx-9',
  status: 'success',
  amount: 100,
  fee: 1,
  paymentAt: '2026-09-05T12:00:00.000Z',
  orderno: 'tx-9',
  payType: 'PAYOUT',
};

const pendingRow = {
  id: 'gpw_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PC-w1',
  gateway_transaction_id: 'tx-9',
  amount: '100',
  bank_code: 'DUMMYBANKVERIFIED',
  account_number: '543478924652',
  account_holder_name: 'Michael Yap',
  status: 'pending',
  failure_reason: null,
  gateway: 'tgpay',
};

function harness(row: Record<string, unknown> | null) {
  const packs = {
    listGlobePayWithdrawals: jest.fn().mockResolvedValue(row ? [row] : []),
    updateGlobePayWithdrawals: jest.fn().mockResolvedValue(undefined),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const req = {
    body: {},
    headers: { ...AUTH },
    scope: { resolve: (k: string) => (k === 'logger' ? logger : packs) },
  };
  const res = {
    statusCode: 0,
    body: '',
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(payload: string) {
      this.body = payload;
      return this;
    },
  };
  return { packs, logger, req, res };
}

const run = async (
  h: ReturnType<typeof harness>,
  body: Record<string, unknown>,
  headers?: Record<string, unknown>,
) => {
  h.req.body = body;
  if (headers) h.req.headers = headers as never;
  await POST(h.req as never, h.res as never);
  return h.res;
};

describe('tgpay withdrawal callback — source allowlist', () => {
  afterEach(() => {
    delete process.env.TGPAY_CALLBACK_IPS;
  });

  it('with TGPAY_CALLBACK_IPS set, a foreign source is refused with 403 before any lookup', async () => {
    process.env.TGPAY_CALLBACK_IPS = '1.32.102.19, 54.251.58.7';
    const h = harness(pendingRow);
    (h.req as { ip?: string }).ip = '9.9.9.9';
    // A spoofed header must not rescue it.
    h.req.headers = { ...AUTH, 'x-forwarded-for': '1.32.102.19' } as never;
    const res = await run(h, success);
    expect(res.statusCode).toBe(403);
    expect(h.packs.listGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(h.logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/rejected withdrawal callback from 9\.9\.9\.9/),
    );
  });

  it('a listed source passes on to the key check', async () => {
    process.env.TGPAY_CALLBACK_IPS = '1.32.102.19, 54.251.58.7';
    const h = harness(pendingRow);
    (h.req as { ip?: string }).ip = '::ffff:54.251.58.7';
    const res = await run(h, success);
    expect(res.statusCode).toBe(200);
    expect(h.packs.listGlobePayWithdrawals).toHaveBeenCalled();
  });

  it('unset means header-only, as on the sandbox', async () => {
    const h = harness(pendingRow);
    (h.req as { ip?: string }).ip = '9.9.9.9';
    const res = await run(h, success);
    expect(res.statusCode).toBe(200);
  });
});

describe('tgpay payout callback', () => {
  it('rejects bad key headers with 401 before any lookup', async () => {
    const h = harness(pendingRow);
    const res = await run(h, success, { 'x-public-key': 'pk-test' });
    expect(res.statusCode).toBe(401);
    expect(h.packs.listGlobePayWithdrawals).not.toHaveBeenCalled();
  });

  it('finds the row by the GATEWAY id (the body carries no merchantRefNum) and settles it', async () => {
    const h = harness(pendingRow);
    const res = await run(h, success);
    expect(res.statusCode).toBe(200);
    expect(h.packs.listGlobePayWithdrawals).toHaveBeenCalledWith(
      { gateway_transaction_id: 'tx-9', gateway: 'tgpay' },
      { take: 1 },
    );
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: { id: 'gpw_1', status: 'pending' },
        data: expect.objectContaining({
          status: 'settled',
          amount_settled: 100,
          // fee = gross − net in the settlement report, so net = 100 − 1.
          net_amount: 99,
        }),
      }),
    );
    expect(refundGlobePayWithdrawal).not.toHaveBeenCalled();
  });

  it('falls back to OUR reference when the gateway id is not stored yet, and stores it', async () => {
    const h = harness({ ...pendingRow, gateway_transaction_id: null });
    h.packs.listGlobePayWithdrawals
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ ...pendingRow, gateway_transaction_id: null }]);
    const res = await run(h, { ...success, transactionId: 'PC-w1' });
    expect(res.statusCode).toBe(200);
    expect(h.packs.listGlobePayWithdrawals).toHaveBeenLastCalledWith(
      { merchant_transaction_id: 'PC-w1', gateway: 'tgpay' },
      { take: 1 },
    );
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'settled',
          gateway_transaction_id: 'PC-w1',
        }),
      }),
    );
  });

  it('a missing fee leaves net unknown (null), never a zero fee', async () => {
    const h = harness(pendingRow);
    await run(h, { ...success, fee: undefined });
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ net_amount: null }),
      }),
    );
  });

  it('never touches a row that belongs to another gateway', async () => {
    const h = harness({ ...pendingRow, gateway: 'globepay' });
    const res = await run(h, success);
    expect(res.statusCode).toBe(200);
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(refundGlobePayWithdrawal).not.toHaveBeenCalled();
  });

  it('a reject refunds through the shared helper, from status pending', async () => {
    const h = harness(pendingRow);
    const res = await run(h, { ...success, status: 'reject' });
    expect(res.statusCode).toBe(200);
    expect(refundGlobePayWithdrawal).toHaveBeenCalledWith(
      h.req.scope,
      pendingRow,
      null,
      'pending',
      expect.stringMatching(/callback reject/),
    );
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
  });

  it('pending is acknowledged and changes nothing', async () => {
    const h = harness(pendingRow);
    const res = await run(h, { ...success, status: 'pending' });
    expect(res.statusCode).toBe(200);
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
    expect(refundGlobePayWithdrawal).not.toHaveBeenCalled();
  });

  it('a replay on a settled row is a no-op, an unknown id is acknowledged', async () => {
    const settled = harness({ ...pendingRow, status: 'settled' });
    expect((await run(settled, success)).statusCode).toBe(200);
    expect(settled.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();

    const unknown = harness(null);
    expect((await run(unknown, success)).statusCode).toBe(200);
    expect(unknown.logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/UNKNOWN payout/),
    );
  });

  it('a refund failure answers 500 so TGPay retries', async () => {
    (refundGlobePayWithdrawal as jest.Mock).mockRejectedValueOnce(
      new Error('db down'),
    );
    const h = harness(pendingRow);
    const res = await run(h, { ...success, status: 'reject' });
    expect(res.statusCode).toBe(500);
  });
});
