jest.mock('../../../../../modules/packs/notify-feed', () => ({
  notifyFeed: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../../modules/packs/topup-receipt', () => ({
  sendTopupReceipt: jest.fn().mockResolvedValue(undefined),
}));

import { POST } from '../route';
import { GLOBEPAY_MAX_RM } from '../../../../../modules/packs/globepay-deposit';
import { topupIdempotencyReference } from '../../../../../modules/packs/topup';

beforeEach(() => {
  process.env.TGPAY_API_BASE = 'https://sandbox-api.example.test/api/v2';
  process.env.TGPAY_PUBLIC_KEY = 'pk-test';
  process.env.TGPAY_SECRET_KEY = 'sk-test';
});

const AUTH = { 'x-public-key': 'pk-test', 'x-secret-key': 'sk-test' };

function notify(data: Record<string, unknown>) {
  return { status: 1, msg: 'Success', data };
}

const approved = {
  amount: 50,
  transactionRefNum: 'tx-1',
  merchantRefNum: 'PC-1',
  paymentMethod: 'FPX',
  bankName: 'Maybank',
  status: 'APPROVED',
};

function harness(deposit: Record<string, unknown> | null) {
  const packs = {
    listGlobePayDeposits: jest.fn().mockResolvedValue(deposit ? [deposit] : []),
    updateGlobePayDeposits: jest.fn().mockResolvedValue(undefined),
    topUpCreditsWithLedger: jest.fn().mockResolvedValue({
      id: 'ct_1',
      balance: 50,
      amount: 50,
      replayed: false,
      reference: null,
    }),
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

const pendingRow = {
  id: 'gpd_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PC-1',
  gateway_transaction_id: 'tx-1',
  amount_requested: 50,
  payment_method_code: 'OB',
  status: 'pending',
  gateway: 'tgpay',
};

describe('tgpay deposit callback — authentication', () => {
  it('rejects a missing or wrong key header with 401 and touches nothing', async () => {
    for (const headers of [
      {},
      { 'x-public-key': 'pk-test' },
      { ...AUTH, 'x-secret-key': 'sk-wrong' },
    ]) {
      const h = harness(pendingRow);
      const res = await run(h, notify(approved), headers);
      expect(res.statusCode).toBe(401);
      expect(h.packs.listGlobePayDeposits).not.toHaveBeenCalled();
      expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    }
  });

  it('rejects a body with no merchantRefNum', async () => {
    const h = harness(pendingRow);
    const res = await run(
      h,
      notify({ ...approved, merchantRefNum: undefined }),
    );
    expect(res.statusCode).toBe(400);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });
});

describe('tgpay deposit callback — settlement', () => {
  it('credits an APPROVED payment once, keyed on OUR reference, and settles the row', async () => {
    const h = harness(pendingRow);
    const res = await run(h, notify(approved));
    expect(res.statusCode).toBe(200);
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_1',
        amount: 50,
        reason: 'topup',
        ledgerPaymentMethod: 'OB',
        reference: 'tx-1',
        idempotencyReference: topupIdempotencyReference('cus_1', 'PC-1'),
      }),
    );
    expect(h.packs.updateGlobePayDeposits).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: { id: 'gpd_1', status: 'pending' },
        data: expect.objectContaining({
          status: 'settled',
          amount_settled: 50,
          gateway_transaction_id: 'tx-1',
        }),
      }),
    );
  });

  it('accepts the flat (unwrapped) body shape too', async () => {
    const h = harness(pendingRow);
    const res = await run(h, approved);
    expect(res.statusCode).toBe(200);
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledTimes(1);
  });

  it('PENDING and unknown statuses credit nothing and answer 200', async () => {
    for (const status of ['PENDING', 'PROCESSING', '']) {
      const h = harness(pendingRow);
      const res = await run(h, notify({ ...approved, status }));
      expect(res.statusCode).toBe(200);
      expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
      expect(h.packs.updateGlobePayDeposits).not.toHaveBeenCalled();
    }
  });

  it('a reject closes the row without crediting', async () => {
    const h = harness(pendingRow);
    await run(h, notify({ ...approved, status: 'REJECT' }));
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayDeposits).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });

  it('an unknown reference is acknowledged (200) but credits nothing', async () => {
    const h = harness(null);
    const res = await run(h, notify(approved));
    expect(res.statusCode).toBe(200);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/UNKNOWN deposit/),
    );
  });

  it('never touches a row that belongs to another gateway', async () => {
    for (const gateway of ['globepay', undefined]) {
      const h = harness({ ...pendingRow, gateway });
      const res = await run(h, notify(approved));
      expect(res.statusCode).toBe(200);
      expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
      expect(h.packs.updateGlobePayDeposits).not.toHaveBeenCalled();
      expect(h.logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/belongs to gateway/),
      );
    }
  });

  it('a replayed APPROVED on an already-settled row is a no-op', async () => {
    const h = harness({ ...pendingRow, status: 'settled' });
    const res = await run(h, notify(approved));
    expect(res.statusCode).toBe(200);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('refuses a non-positive or above-ceiling amount', async () => {
    for (const amount of [0, -5, 'abc', GLOBEPAY_MAX_RM + 1]) {
      const h = harness(pendingRow);
      const res = await run(h, notify({ ...approved, amount }));
      expect(res.statusCode).toBe(400);
      expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    }
  });
});
