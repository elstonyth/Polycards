jest.mock('../../../../modules/packs/notify-feed', () => ({
  notifyFeed: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../modules/packs/topup-receipt', () => ({
  sendTopupReceipt: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../modules/packs/withdrawal-receipt', () => ({
  sendWithdrawalReceipt: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../../modules/packs/ops-alert', () => ({
  alertOps: jest.fn().mockResolvedValue(undefined),
}));

import { POST as deposit } from '../deposit/route';
import { POST as withdrawal } from '../withdrawal/route';
import { gmpaySign } from '../../../../modules/packs/gmpay-client';

const SECRET = 'gmpay-test-secret';

beforeEach(() => {
  Object.assign(process.env, {
    GMPAY_API_BASE: 'https://xapi.example.test/v3',
    GMPAY_CLIENT_ID: 'client-1',
    GMPAY_SECRET_KEY: SECRET,
  });
});

/** A GMpay-shaped raw body, signed with `secret` (ours unless overridden). */
function signed(fields: Record<string, unknown>, secret = SECRET): string {
  return JSON.stringify({
    ...fields,
    tran_signature: gmpaySign(fields, secret),
  });
}

function harness(rows: Record<string, unknown>[]) {
  const packs = {
    listGatewayDeposits: jest.fn().mockResolvedValue(rows),
    listGatewayWithdrawals: jest.fn().mockResolvedValue(rows),
    claimDepositStatus: jest.fn().mockResolvedValue(true),
    claimWithdrawalStatus: jest.fn().mockResolvedValue(true),
    claimWithdrawalAgainstDebit: jest.fn().mockResolvedValue(true),
    updateGatewayWithdrawals: jest.fn().mockResolvedValue(undefined),
    withdrawCreditsWithLedger: jest
      .fn()
      .mockResolvedValue({ balance: 0, replayed: false }),
    topUpCreditsWithLedger: jest.fn().mockResolvedValue({
      id: 'ct_1',
      balance: 319,
      amount: 319,
      replayed: false,
      reference: null,
    }),
    listCreditTransactions: jest.fn().mockResolvedValue([{ id: 'debit' }]),
  };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const req = {
    body: {} as unknown,
    rawBody: undefined as string | undefined,
    headers: {},
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

async function run(
  handler: typeof deposit,
  h: ReturnType<typeof harness>,
  raw: string | undefined,
) {
  h.req.rawBody = raw;
  h.req.body = raw ? JSON.parse(raw) : {};
  await handler(h.req as never, h.res as never);
  return h.res;
}

// S$100 locked at mid 3.20, markup 0.01 -> credit RM 319.00.
const sgdDeposit = {
  id: 'gpd_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PC-1',
  gateway_transaction_id: 'tok-1',
  amount_requested: '319',
  payment_method_code: 'BQR',
  status: 'pending',
  gateway: 'gmpay',
  currency: 'SGD',
  gateway_amount: '100',
  fx_mid: '3.2',
  fx_markup: '0.01',
};

const payin = (over: Record<string, unknown> = {}) => ({
  status_code: 0,
  status_msg: 'NO_ERROR',
  tran_token: 'tok-1',
  tran_reference: 'REF1',
  tran_customer: 'cus_1',
  tran_amount: 100,
  tran_actual_amount: 100,
  tran_unique: 'PC-1',
  tran_fee: 1.1,
  tran_status: 'completed',
  tran_createtime: '2026-11-19 18:00:00',
  tran_lastupdated: '2026-11-19 18:01:00',
  ...over,
});

describe('POST /hooks/gmpay/deposit', () => {
  it('credits the RM locked on the row for the S$ paid, and answers OK', async () => {
    const h = harness([sgdDeposit]);
    const res = await run(deposit, h, signed(payin()));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('OK');
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cus_1', amount: 319 }),
    );
    // Net of their fee at the same locked rate: 98.9 * 3.19 = 315.491.
    expect(h.packs.claimDepositStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'settled',
        money: expect.objectContaining({
          amount_settled: 319,
          net_amount: 315.49,
        }),
      }),
    );
  });

  it('checks the signature over the numbers as written (100.00)', async () => {
    const h = harness([sgdDeposit]);
    const fields = {
      ...payin(),
      tran_amount: '100.00',
      tran_actual_amount: '100.00',
      tran_fee: '1.10',
    };
    const sig = gmpaySign(fields, SECRET);
    const raw = JSON.stringify({ ...fields, tran_signature: sig })
      .replace('"tran_amount":"100.00"', '"tran_amount":100.00')
      .replace('"tran_actual_amount":"100.00"', '"tran_actual_amount":100.00')
      .replace('"tran_fee":"1.10"', '"tran_fee":1.10');
    const res = await run(deposit, h, raw);
    expect(res.body).toBe('OK');
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalled();
  });

  it('refuses a callback not signed with our key — nothing credited', async () => {
    const h = harness([sgdDeposit]);
    const res = await run(deposit, h, signed(payin(), 'someone-else'));
    expect(res.statusCode).toBe(400);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('refuses a tampered amount under a valid signature', async () => {
    const h = harness([sgdDeposit]);
    const raw = signed(payin()).replace(
      '"tran_actual_amount":100',
      '"tran_actual_amount":1000',
    );
    const res = await run(deposit, h, raw);
    expect(res.statusCode).toBe(400);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('refuses when the route lost the raw body', async () => {
    const h = harness([sgdDeposit]);
    const res = await run(deposit, h, undefined);
    expect(res.statusCode).toBe(400);
  });

  it('refuses a token that is not the one on the row', async () => {
    const h = harness([sgdDeposit]);
    const res = await run(
      deposit,
      h,
      signed(payin({ tran_token: 'tok-OTHER' })),
    );
    expect(res.statusCode).toBe(400);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('refuses to credit a sum other than the locked S$', async () => {
    const h = harness([sgdDeposit]);
    const res = await run(
      deposit,
      h,
      signed(payin({ tran_amount: 90, tran_actual_amount: 90 })),
    );
    expect(res.statusCode).toBe(400);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('never credits "completed" alongside an error status_code', async () => {
    const h = harness([sgdDeposit]);
    const res = await run(
      deposit,
      h,
      signed(payin({ status_code: -1, status_msg: 'ERR' })),
    );
    expect(res.statusCode).toBe(400);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('acknowledges an unknown reference without crediting anything', async () => {
    const h = harness([]);
    const res = await run(deposit, h, signed(payin()));
    expect(res.body).toBe('OK');
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('ignores a row that belongs to another gateway', async () => {
    const h = harness([{ ...sgdDeposit, gateway: 'a3pay' }]);
    const res = await run(deposit, h, signed(payin()));
    expect(res.body).toBe('OK');
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('credits a deposit the sweep had written off, when they say it completed', async () => {
    const h = harness([{ ...sgdDeposit, status: 'expired' }]);
    const res = await run(deposit, h, signed(payin()));
    expect(res.body).toBe('OK');
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalled();
  });

  it('answers 503 when GMpay is not configured here', async () => {
    delete process.env.GMPAY_SECRET_KEY;
    const h = harness([sgdDeposit]);
    const res = await run(deposit, h, signed(payin()));
    expect(res.statusCode).toBe(503);
  });
});

// RM 100 debited, S$31.15 locked at mid 3.20.
const sgdPayout = {
  id: 'gpw_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PW-1',
  gateway_transaction_id: 'tok-w1',
  amount: '100',
  bank_code: 'DBSSSGSG',
  account_number: '1234567890',
  account_holder_name: 'TAN AH KOW',
  status: 'pending',
  gateway: 'gmpay',
  currency: 'SGD',
  gateway_amount: '31.15',
  fx_mid: '3.2',
  fx_markup: '0.01',
  updated_at: new Date(),
  created_at: new Date(),
};

const payout = (over: Record<string, unknown> = {}) => ({
  status_code: 0,
  status_msg: 'NO_ERROR',
  tran_token: 'tok-w1',
  tran_customer: 'cus_1',
  bank_code: 'DBS',
  bank_account_name: 'TAN AH KOW',
  bank_account_number: '1234567890',
  tran_amount: 31.15,
  tran_actual_amount: 31.15,
  tran_unique: 'PW-1',
  tran_fee: 0.5,
  tran_status: 'completed',
  tran_createtime: '2026-11-19 18:00:00',
  tran_lastupdated: '2026-11-19 18:05:00',
  ...over,
});

describe('POST /hooks/gmpay/withdrawal', () => {
  it('settles a completed payout, no refund, and answers OK', async () => {
    const h = harness([sgdPayout]);
    const res = await run(withdrawal, h, signed(payout()));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('OK');
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(
      h.packs.claimWithdrawalStatus.mock.calls.length +
        h.packs.claimWithdrawalAgainstDebit.mock.calls.length,
    ).toBeGreaterThan(0);
  });

  it('refunds a rejected payout', async () => {
    const h = harness([sgdPayout]);
    const res = await run(
      withdrawal,
      h,
      signed(
        payout({
          tran_status: 'rejected',
          tran_reject_reason: 'Invalid account',
        }),
      ),
    );
    expect(res.body).toBe('OK');
    expect(h.packs.withdrawCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 100, customerId: 'cus_1' }),
    );
  });

  it('redacts the account number and holder name out of their reject reason', async () => {
    const h = harness([sgdPayout]);
    await run(
      withdrawal,
      h,
      signed(
        payout({
          tran_status: 'rejected',
          tran_reject_reason: 'acct 1234567890 name Tan Ah Kow mismatch',
        }),
      ),
    );
    const [[{ set }]] = h.packs.claimWithdrawalStatus.mock.calls;
    expect(set.failure_reason).toBe(
      'callback rejected: acct [redacted] name [redacted] mismatch',
    );
  });

  it('refuses a payout callback signed by anyone else — nothing moves', async () => {
    const h = harness([sgdPayout]);
    const res = await run(
      withdrawal,
      h,
      signed(payout({ tran_status: 'rejected' }), 'nope'),
    );
    expect(res.statusCode).toBe(400);
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('refuses a token that is not the one on the row — no refund', async () => {
    const h = harness([sgdPayout]);
    const res = await run(
      withdrawal,
      h,
      signed(payout({ tran_status: 'rejected', tran_token: 'tok-OTHER' })),
    );
    expect(res.statusCode).toBe(400);
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
  });
});

describe('POST /hooks/gmpay/deposit, no nudge window', () => {
  it('refuses S$100.01 against a S$100 lock: GMpay does not nudge', async () => {
    const h = harness([sgdDeposit]);
    const res = await run(
      deposit,
      h,
      signed(payin({ tran_amount: 100, tran_actual_amount: 100.01 })),
    );
    expect(res.statusCode).toBe(400);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });
});
