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
import { alertOps } from '../../../../modules/packs/ops-alert';

import { generateKeyPairSync } from 'node:crypto';
import { POST as deposit } from '../deposit/route';
import { POST as withdrawal } from '../withdrawal/route';
import { POST as verify } from '../payout-verify/route';
import { aesEncrypt, signPayload } from '../../../../modules/packs/a3pay';
import { sweepAlertsVerifyFail } from '../../../../modules/packs/gateway-deposit';

// Two throwaway pairs: OURS (unused by inbound hooks) and A3PAY's, whose
// private half plays A3Pay signing callbacks.
function pair() {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    publicKey: publicKey.toString('base64'),
    privateKey: privateKey.toString('base64'),
  };
}
const ours = pair();
const theirs = pair();
const stranger = pair();
const AES = 'test-aes-key';

beforeEach(() => {
  Object.assign(process.env, {
    A3PAY_API_BASE: 'https://mapi.example.test',
    A3PAY_MERCHANT_CODE: 'SGD00001',
    A3PAY_AES_KEY: AES,
    A3PAY_MERCHANT_PRIVATE_KEY: ours.privateKey,
    A3PAY_PUBLIC_KEY: theirs.publicKey,
  });
});

/** An A3Pay-shaped message, signed by `signer` (A3Pay unless overridden). */
function message(data: Record<string, unknown>, signer = theirs.privateKey) {
  const json = JSON.stringify(data);
  return {
    TransactionId: 'D2026100600000001',
    MerchantTransactionId: data.MerchantTransactionId,
    Data: aesEncrypt(json, AES),
    Signature: signPayload(json, signer),
    Version: 0,
  };
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
  const pg = { raw: jest.fn().mockResolvedValue(undefined) };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const req = {
    body: {} as unknown,
    headers: {},
    scope: {
      resolve: (k: string) =>
        k === 'logger' ? logger : k === '__pg_connection__' ? pg : packs,
    },
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
  return { packs, pg, logger, req, res };
}

type Handler = typeof deposit;
async function run(
  handler: Handler,
  h: ReturnType<typeof harness>,
  body: unknown,
) {
  h.req.body = body;
  await handler(h.req as never, h.res as never);
  return h.res;
}

// S$100 locked at mid 3.20, markup 0.01 -> credit RM 319.00.
const sgdDeposit = {
  id: 'gpd_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PC-1',
  gateway_transaction_id: 'D2026100600000001',
  amount_requested: '319',
  payment_method_code: 'OB',
  status: 'pending',
  gateway: 'a3pay',
  currency: 'SGD',
  gateway_amount: '100',
  fx_mid: '3.2',
  fx_markup: '0.01',
};

const payin = (over: Record<string, unknown> = {}) => ({
  MerchantCode: 'SGD00001',
  CurrencyCode: 'SGD',
  MerchantTransactionId: 'PC-1',
  Status: 6,
  Amount: 100,
  NetAmount: 98.5,
  PaymentMethodCode: 'OB',
  ...over,
});

describe('POST /hooks/a3pay/deposit', () => {
  it('credits the RM locked on the row for the S$ paid', async () => {
    const h = harness([sgdDeposit]);
    const res = await run(deposit, h, message(payin()));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('success');
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cus_1', amount: 319 }),
    );
    // Their fee converted at the same locked rate: 98.5 * 3.19 = 314.215.
    expect(h.packs.claimDepositStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'settled',
        money: expect.objectContaining({
          amount_settled: 319,
          net_amount: 314.21,
        }),
      }),
    );
  });

  it('records what the ledger credited when the credit was a replay', async () => {
    // A sweep credited this deposit first (proportionally, RM 318.97); the
    // callback's own figure (the locked RM 319) was never written.
    const h = harness([sgdDeposit]);
    h.packs.topUpCreditsWithLedger.mockResolvedValueOnce({
      id: 'ct_0',
      balance: 318.97,
      amount: 318.97,
      replayed: true,
      reference: null,
    });
    await run(deposit, h, message(payin()));
    expect(h.packs.claimDepositStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        money: expect.objectContaining({ amount_settled: 318.97 }),
      }),
    );
  });

  it('refuses a callback signed by anyone but A3Pay — nothing credited', async () => {
    const h = harness([sgdDeposit]);
    const res = await run(deposit, h, message(payin(), stranger.privateKey));
    expect(res.statusCode).toBe(400);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('refuses a tampered envelope (Data swapped under the signature)', async () => {
    const h = harness([sgdDeposit]);
    const good = message(payin());
    const forged = {
      ...good,
      Data: aesEncrypt(JSON.stringify(payin({ Amount: 3000 })), AES),
    };
    const res = await run(deposit, h, forged);
    expect(res.statusCode).toBe(400);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('treats payin status 4 (Verify Fail) as NOT final, and alerts ops', async () => {
    (alertOps as jest.Mock).mockClear();
    const h = harness([sgdDeposit]);
    const res = await run(deposit, h, message(payin({ Status: 4 })));
    expect(res.body).toBe('success');
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.claimDepositStatus).not.toHaveBeenCalled();
    // A3Pay matches by exact amount only: the customer most likely never
    // paid. The text must not invite a hand credit the sweep could repeat.
    expect(alertOps).toHaveBeenCalledWith(
      expect.anything(),
      'payin-verify-fail:PC-1',
      expect.stringContaining('Verify Fail'),
      { muteMs: 6 * 60 * 60 * 1000 },
    );
    const [[, , text]] = (alertOps as jest.Mock).mock.calls;
    expect(text).toMatch(/exact amount/);
    expect(text).toMatch(/Never credit it by admin adjustment/);
    expect(text).not.toMatch(/payer name/);
  });

  it('the sweep alerts a Verify Fail only while the deposit is pending', () => {
    expect(sweepAlertsVerifyFail({ gateway: 'a3pay', status: 'pending' }, 4)).toBe(true);
    // An expired row is requeried for days; each pass re-alerted it.
    expect(sweepAlertsVerifyFail({ gateway: 'a3pay', status: 'expired' }, 4)).toBe(false);
    expect(sweepAlertsVerifyFail({ gateway: 'tgpay', status: 'pending' }, 4)).toBe(false);
    expect(sweepAlertsVerifyFail({ gateway: 'a3pay', status: 'pending' }, 6)).toBe(false);
  });

  it('reports a late Verify Fail on a row already written off, not on a credited one', async () => {
    (alertOps as jest.Mock).mockClear();
    await run(
      deposit,
      harness([{ ...sgdDeposit, status: 'expired' }]),
      message(payin({ Status: 4 })),
    );
    expect(alertOps).toHaveBeenCalledWith(
      expect.anything(),
      'payin-verify-fail:PC-1',
      expect.any(String),
      { muteMs: 6 * 60 * 60 * 1000 },
    );
    (alertOps as jest.Mock).mockClear();
    await run(
      deposit,
      harness([{ ...sgdDeposit, status: 'settled' }]),
      message(payin({ Status: 4 })),
    );
    expect(alertOps).not.toHaveBeenCalled();
  });

  it('closes the row on status 7 without crediting', async () => {
    const h = harness([sgdDeposit]);
    await run(deposit, h, message(payin({ Status: 7 })));
    expect(h.packs.claimDepositStatus).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'failed' }),
    );
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('refuses an amount other than the locked S$ (the sweep settles it)', async () => {
    const h = harness([sgdDeposit]);
    const res = await run(deposit, h, message(payin({ Amount: 150 })));
    expect(res.statusCode).toBe(400);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('refuses another merchant or another currency, even when signed', async () => {
    for (const over of [
      { MerchantCode: 'SGD99999' },
      { CurrencyCode: 'MYR' },
    ]) {
      const h = harness([sgdDeposit]);
      const res = await run(deposit, h, message(payin(over)));
      expect(res.statusCode).toBe(400);
      expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    }
  });

  it('never touches a row created under another gateway', async () => {
    const h = harness([{ ...sgdDeposit, gateway: 'tgpay' }]);
    const res = await run(deposit, h, message(payin()));
    expect(res.body).toBe('success');
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });
});

// RM 100 debited, locked at payout rate 3.21 -> S$31.15 out.
const sgdPayout = {
  id: 'gpw_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PW-1',
  gateway_transaction_id: 'W2026100600000001',
  amount: '100',
  bank_code: 'DBSSSGSG',
  account_number: '1234567890',
  account_holder_name: 'TAN AH KOW',
  status: 'pending',
  gateway: 'a3pay',
  currency: 'SGD',
  gateway_amount: '31.15',
  fx_mid: '3.2',
  fx_markup: '0.01',
  updated_at: new Date(),
  created_at: new Date(),
};

describe('POST /hooks/a3pay/payout-verify', () => {
  const verifyData = (over: Record<string, unknown> = {}) => ({
    MerchantTransactionId: 'PW-1',
    Amount: 31.15,
    CurrencyCode: 'SGD',
    ...over,
  });

  it('answers "success" for our pending row at the locked S$ amount', async () => {
    const h = harness([sgdPayout]);
    const res = await run(verify, h, message(verifyData()));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('success');
    expect(h.pg.raw).toHaveBeenCalledWith(
      expect.stringContaining('verify_outcome'),
      [expect.stringMatching(/ success$/), 'gpw_1'],
    );
  });

  it('rejects the RM figure presented as S$, an unknown row, or a closed one', async () => {
    const cases: [Record<string, unknown>[], Record<string, unknown>][] = [
      [[sgdPayout], verifyData({ Amount: 100 })],
      [[], verifyData()],
      [[{ ...sgdPayout, status: 'failed' }], verifyData()],
      [[sgdPayout], verifyData({ CurrencyCode: 'MYR' })],
    ];
    for (const [rows, data] of cases) {
      const h = harness(rows);
      const res = await run(verify, h, message(data));
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toBe('success');
    }
  });

  it('rejects a forged verification', async () => {
    const h = harness([sgdPayout]);
    const res = await run(
      verify,
      h,
      message(verifyData(), stranger.privateKey),
    );
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /hooks/a3pay/withdrawal', () => {
  const payout = (over: Record<string, unknown> = {}) => ({
    MerchantCode: 'SGD00001',
    CurrencyCode: 'SGD',
    MerchantTransactionId: 'PW-1',
    Status: 4,
    Amount: 31.15,
    NetAmount: 32.15,
    Remark: 'Success',
    PaymentMethodCode: 'WD',
    ...over,
  });

  it('settles on status 4 with the RM figures at the locked rate', async () => {
    const h = harness([sgdPayout]);
    const res = await run(withdrawal, h, message(payout()));
    expect(res.body).toBe('success');
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(
      h.packs.claimWithdrawalStatus.mock.calls.length +
        h.packs.claimWithdrawalAgainstDebit.mock.calls.length,
    ).toBeGreaterThan(0);
  });

  it('refunds on status 5', async () => {
    const h = harness([sgdPayout]);
    const res = await run(withdrawal, h, message(payout({ Status: 5 })));
    expect(res.body).toBe('success');
    expect(h.packs.withdrawCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 100, customerId: 'cus_1' }),
    );
  });

  it("redacts the account number and holder name out of A3Pay's Remark", async () => {
    const h = harness([sgdPayout]);
    await run(
      withdrawal,
      h,
      message(
        payout({
          Status: 5,
          Remark: 'acct 1234567890 name Tan Ah Kow mismatch',
        }),
      ),
    );
    const [[{ data }]] = h.packs.updateGatewayWithdrawals.mock.calls;
    expect(data.failure_reason).toBe(
      'callback status 5: acct [redacted] name [redacted] mismatch',
    );
  });

  it('alerts ops when a success settled the row while the refund was in flight', async () => {
    const h = harness([sgdPayout]);
    h.packs.listGatewayWithdrawals
      .mockResolvedValueOnce([sgdPayout])
      .mockResolvedValueOnce([{ ...sgdPayout, status: 'settled' }]);
    // The close is scoped to 'pending' and lost the race: zero rows updated.
    h.packs.updateGatewayWithdrawals.mockResolvedValueOnce([]);
    (alertOps as jest.Mock).mockClear();
    await run(withdrawal, h, message(payout({ Status: 5 })));
    expect(alertOps).toHaveBeenCalledWith(
      expect.anything(),
      'refund-vs-settled:PW-1',
      expect.stringContaining('REFUNDED'),
    );
  });

  it('stays quiet when the close lost to another refund, not a success', async () => {
    const h = harness([sgdPayout]);
    h.packs.listGatewayWithdrawals
      .mockResolvedValueOnce([sgdPayout])
      .mockResolvedValueOnce([{ ...sgdPayout, status: 'failed' }]);
    h.packs.updateGatewayWithdrawals.mockResolvedValueOnce([]);
    (alertOps as jest.Mock).mockClear();
    await run(withdrawal, h, message(payout({ Status: 5 })));
    expect(alertOps).not.toHaveBeenCalledWith(
      expect.anything(),
      'refund-vs-settled:PW-1',
      expect.anything(),
    );
  });

  it('refuses a forged payout callback', async () => {
    const h = harness([sgdPayout]);
    const res = await run(
      withdrawal,
      h,
      message(payout({ Status: 5 }), stranger.privateKey),
    );
    expect(res.statusCode).toBe(400);
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
  });
});

describe('review fixes (2026-10-06)', () => {
  it('a nudged payin (S$100.01 on a S$100 lock) credits exactly the locked RM 319.00', async () => {
    const h = harness([sgdDeposit]);
    const res = await run(deposit, h, message(payin({ Amount: 100.01 })));
    expect(res.statusCode).toBe(200);
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 319 }),
    );
  });

  it('an SGD row that lost its lock is never credited S$ as RM', async () => {
    const h = harness([{ ...sgdDeposit, gateway_amount: null }]);
    const res = await run(deposit, h, message(payin()));
    expect(res.statusCode).toBe(400);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('answers 503, not a crash, when A3Pay is not configured', async () => {
    const saved = process.env.A3PAY_AES_KEY;
    delete process.env.A3PAY_AES_KEY;
    try {
      for (const handler of [deposit, withdrawal, verify]) {
        const h = harness([sgdDeposit]);
        const res = await run(handler, h, message(payin()));
        expect(res.statusCode).toBe(503);
        expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
      }
    } finally {
      process.env.A3PAY_AES_KEY = saved;
    }
  });
});
