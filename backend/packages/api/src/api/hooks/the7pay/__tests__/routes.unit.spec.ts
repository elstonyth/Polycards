jest.mock('../../../../modules/packs/notify-feed', () => ({
  notifyFeed: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../modules/packs/topup-receipt', () => ({
  sendTopupReceipt: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../modules/packs/gateway-withdrawal', () => ({
  refundWithdrawal: jest.fn().mockResolvedValue({ replayed: false }),
  applyWithdrawalOutcome: jest.fn().mockResolvedValue({ replayed: false }),
}));

import { createHmac } from 'node:crypto';
import { POST as depositHook } from '../deposit/route';
import { POST as withdrawalHook } from '../withdrawal/route';
import { applyWithdrawalOutcome } from '../../../../modules/packs/gateway-withdrawal';

// The 7 Pay's hooks run TGPay's handlers (src/api/utils/tgpay-family-hooks.ts,
// covered in depth by the TGPay hook specs). What is pinned here is what the
// binding changes: THE7PAY_* keys, the HMAC (Method 2) callback over the raw
// body, and that only the7pay rows are ever touched.

beforeEach(() => {
  process.env.THE7PAY_API_BASE = 'https://sandbox-api.the7pay.test/api/v1';
  process.env.THE7PAY_PUBLIC_KEY = 'pk-7';
  process.env.THE7PAY_SECRET_KEY = 'sk-7';
  process.env.TGPAY_API_BASE = 'https://sandbox-api.tgpay.test/api/v2';
  process.env.TGPAY_PUBLIC_KEY = 'pk-tg';
  process.env.TGPAY_SECRET_KEY = 'sk-tg';
  (applyWithdrawalOutcome as jest.Mock).mockClear();
});

const sign = (raw: string) =>
  createHmac('sha256', 'pk-7sk-7').update(raw, 'utf8').digest('hex');

function harness() {
  const packs = {
    listGatewayDeposits: jest.fn(),
    claimDepositStatus: jest.fn().mockResolvedValue(true),
    topUpCreditsWithLedger: jest.fn().mockResolvedValue({
      id: 'ct_1',
      balance: 50,
      amount: 50,
      replayed: false,
      reference: null,
    }),
    listGatewayWithdrawals: jest.fn(),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const res = {
    statusCode: 0,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send() {
      return this;
    },
  };
  const req = (body: unknown, headers: Record<string, string>, raw?: string) =>
    ({
      body,
      rawBody: raw === undefined ? undefined : Buffer.from(raw, 'utf8'),
      headers,
      scope: { resolve: (k: string) => (k === 'logger' ? logger : packs) },
    }) as never;
  return { packs, logger, res, req };
}

const approved = {
  status: 1,
  msg: 'Success',
  data: {
    amount: 50,
    transactionRefNum: 'tx-1',
    merchantRefNum: 'PC-1',
    paymentMethod: 'EWALLET',
    bankName: 'TNG eWallet',
    status: 'APPROVED',
  },
};

const deposit = {
  id: 'gpd_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PC-1',
  gateway_transaction_id: 'tx-1',
  amount_requested: 50,
  payment_method_code: 'BQR',
  status: 'pending',
  gateway: 'the7pay',
};

describe('the7pay deposit callback', () => {
  it('credits a payment authenticated by the HMAC of the raw body', async () => {
    const h = harness();
    h.packs.listGatewayDeposits.mockResolvedValue([deposit]);
    const raw = JSON.stringify(approved);
    await depositHook(
      h.req(approved, { 'x-signature': sign(raw) }, raw),
      h.res as never,
    );
    expect(h.res.statusCode).toBe(200);
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledTimes(1);
  });

  it('refuses TGPay’s keys and a signature over different bytes', async () => {
    const raw = JSON.stringify(approved);
    for (const [headers, body] of [
      [{ 'x-public-key': 'pk-tg', 'x-secret-key': 'sk-tg' }, raw],
      [{ 'x-signature': sign(raw) }, `${raw}\n`],
      [{ 'x-signature': sign(raw) }, undefined],
    ] as const) {
      const h = harness();
      h.packs.listGatewayDeposits.mockResolvedValue([deposit]);
      await depositHook(h.req(approved, headers, body), h.res as never);
      expect(h.res.statusCode).toBe(401);
      expect(h.packs.listGatewayDeposits).not.toHaveBeenCalled();
    }
  });

  it('never credits a TGPay row, even with valid 7Pay credentials', async () => {
    const h = harness();
    h.packs.listGatewayDeposits.mockResolvedValue([
      { ...deposit, gateway: 'tgpay' },
    ]);
    await depositHook(
      h.req(approved, { 'x-public-key': 'pk-7', 'x-secret-key': 'sk-7' }),
      h.res as never,
    );
    expect(h.res.statusCode).toBe(200);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/^\[the7pay\] .*belongs to gateway "tgpay"/),
    );
  });
});

describe('the7pay withdrawal callback', () => {
  it('looks payouts up among the7pay rows only, then settles', async () => {
    const h = harness();
    const row = {
      id: 'gpw_1',
      customer_id: 'cus_1',
      merchant_transaction_id: 'PC-w1',
      gateway_transaction_id: 'tx-9',
      amount: '100',
      status: 'pending',
      gateway: 'the7pay',
    };
    h.packs.listGatewayWithdrawals.mockResolvedValue([row]);
    const body = {
      transactionId: 'tx-9',
      status: 'success',
      amount: 100,
      fee: 1,
      paymentAt: '2026-10-09T12:00:00.000Z',
      orderno: 'tx-9',
      payType: 'PAYOUT',
    };
    await withdrawalHook(
      h.req(body, { 'x-public-key': 'pk-7', 'x-secret-key': 'sk-7' }),
      h.res as never,
    );
    expect(h.res.statusCode).toBe(200);
    expect(h.packs.listGatewayWithdrawals).toHaveBeenCalledWith(
      { gateway_transaction_id: 'tx-9', gateway: 'the7pay' },
      { take: 1 },
    );
    expect(applyWithdrawalOutcome).toHaveBeenCalledWith(
      expect.anything(),
      row,
      expect.objectContaining({ netAmount: 101 }),
    );
  });
});
