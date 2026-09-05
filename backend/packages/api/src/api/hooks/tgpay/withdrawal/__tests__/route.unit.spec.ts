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
      { gateway_transaction_id: 'tx-9' },
      { take: 1 },
    );
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: { id: 'gpw_1', status: 'pending' },
        data: expect.objectContaining({
          status: 'settled',
          amount_settled: 100,
        }),
      }),
    );
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
