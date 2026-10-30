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
import { notifyFeed } from '../../../../modules/packs/notify-feed';
import { sendWithdrawalReceipt } from '../../../../modules/packs/withdrawal-receipt';

import { generateKeyPairSync } from 'node:crypto';
import { POST as deposit } from '../deposit/route';
import { POST as withdrawal } from '../withdrawal/route';
import { POST as verify } from '../payout-verify/route';
import { aesEncrypt, signPayload } from '../../../../modules/packs/a3pay';

// GlobePay365 (USDT) runs A3Pay's handlers bound to its own keys and rows.
// The A3Pay suite (../../a3pay/__tests__) covers the handler logic; this one
// proves the binding: GP365 keys, gp365 rows only, USDT.

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
const a3pay = pair();
const AES = 'gp-aes-key';

beforeEach(() => {
  Object.assign(process.env, {
    GP365_API_BASE: 'https://mapi.globepay365stg.test',
    GP365_MERCHANT_CODE: 'GP00001',
    GP365_AES_KEY: AES,
    GP365_MERCHANT_PRIVATE_KEY: ours.privateKey,
    GP365_PUBLIC_KEY: theirs.publicKey,
    // A3Pay configured beside it with ITS OWN key: a message A3Pay signs
    // must not open on the GlobePay365 hooks.
    A3PAY_API_BASE: 'https://mapi.example.test',
    A3PAY_MERCHANT_CODE: 'SGD00001',
    A3PAY_AES_KEY: AES,
    A3PAY_MERCHANT_PRIVATE_KEY: ours.privateKey,
    A3PAY_PUBLIC_KEY: a3pay.publicKey,
  });
});

function message(data: Record<string, unknown>, signer = theirs.privateKey) {
  const json = JSON.stringify(data);
  return {
    TransactionId: 'D2026101200000001',
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
      balance: 430,
      amount: 430,
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

async function run(
  handler: typeof deposit,
  h: ReturnType<typeof harness>,
  body: unknown,
) {
  h.req.body = body;
  await handler(h.req as never, h.res as never);
  return h.res;
}

// 100 USDT locked at mid 4.40, markup 0.10 -> credit RM 430.00.
const usdtDeposit = {
  id: 'gpd_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PC-1',
  gateway_transaction_id: 'D2026101200000001',
  amount_requested: '430',
  payment_method_code: 'UTRC',
  status: 'pending',
  gateway: 'gp365',
  currency: 'USDT',
  gateway_amount: '100',
  fx_mid: '4.4',
  fx_markup: '0.1',
};

const payin = (over: Record<string, unknown> = {}) => ({
  MerchantCode: 'GP00001',
  CurrencyCode: 'USDT',
  MerchantTransactionId: 'PC-1',
  Status: 6,
  Amount: 100,
  NetAmount: 99,
  PaymentMethodCode: 'UTRC',
  ...over,
});

describe('POST /hooks/gp365/deposit', () => {
  it('credits the RM locked on the row for the USDT paid', async () => {
    const h = harness([usdtDeposit]);
    const res = await run(deposit, h, message(payin()));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('success');
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({ customerId: 'cus_1', amount: 430 }),
    );
  });

  it("refuses a message signed with A3Pay's key — nothing credited", async () => {
    const h = harness([usdtDeposit]);
    const res = await run(deposit, h, message(payin(), a3pay.privateKey));
    expect(res.statusCode).toBe(400);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  // Production 2026-10-23..26: GP365_PUBLIC_KEY held our own public key, so
  // every real callback was refused 400 and the alert blamed a key leak.
  it('names our own key in the GP365_PUBLIC_KEY slot as the cause', async () => {
    const misfiled = pair();
    process.env.GP365_MERCHANT_PRIVATE_KEY = misfiled.privateKey;
    process.env.GP365_PUBLIC_KEY = misfiled.publicKey;
    (alertOps as jest.Mock).mockClear();
    const h = harness([usdtDeposit]);
    const res = await run(deposit, h, message(payin()));
    expect(res.statusCode).toBe(400);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    expect(alertOps).toHaveBeenCalledWith(
      expect.anything(),
      'gp365-signature-mismatch',
      expect.stringContaining(
        'GP365_PUBLIC_KEY is the public half of our own GP365_MERCHANT_PRIVATE_KEY',
      ),
      expect.anything(),
    );
  });

  it('a wrong key that is not ours keeps the generic alert', async () => {
    process.env.GP365_PUBLIC_KEY = pair().publicKey;
    (alertOps as jest.Mock).mockClear();
    const h = harness([usdtDeposit]);
    const res = await run(deposit, h, message(payin()));
    expect(res.statusCode).toBe(400);
    expect(alertOps).toHaveBeenCalledWith(
      expect.anything(),
      'gp365-signature-mismatch',
      expect.stringContaining('or our AES key has leaked'),
      expect.anything(),
    );
  });

  it('refuses another currency or merchant from the signed copy', async () => {
    for (const over of [
      { CurrencyCode: 'SGD' },
      { MerchantCode: 'SGD00001' },
    ]) {
      const h = harness([usdtDeposit]);
      const res = await run(deposit, h, message(payin(over)));
      expect(res.statusCode).toBe(400);
      expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    }
  });

  it('Verify Fail (status 4) leaves the row pending and alerts ops', async () => {
    (alertOps as jest.Mock).mockClear();
    const h = harness([usdtDeposit]);
    const res = await run(deposit, h, message(payin({ Status: 4 })));
    expect(res.body).toBe('success');
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.claimDepositStatus).not.toHaveBeenCalled();
    expect(alertOps).toHaveBeenCalledWith(
      expect.anything(),
      'payin-verify-fail:PC-1',
      expect.stringContaining('GlobePay365 (USDT) reports Verify Fail'),
      expect.objectContaining({ muteMs: expect.any(Number) }),
    );
  });

  it('a tail inside its 1 USDT window still settles at the locked credit', async () => {
    const h = harness([usdtDeposit]);
    const res = await run(deposit, h, message(payin({ Amount: 100.37 })));
    expect(res.body).toBe('success');
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 430 }),
    );
  });

  it('never touches an A3Pay row, even when it names one', async () => {
    const h = harness([{ ...usdtDeposit, gateway: 'a3pay', currency: 'SGD' }]);
    const res = await run(deposit, h, message(payin()));
    expect(res.body).toBe('success');
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.claimDepositStatus).not.toHaveBeenCalled();
  });
});

const usdtPayout = {
  id: 'gpw_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PC-9',
  gateway_transaction_id: 'W1',
  amount: '420',
  status: 'pending',
  gateway: 'gp365',
  currency: 'USDT',
  gateway_amount: '91.30',
  fx_mid: '4.5',
  fx_markup: '0.1',
  bank_code: 'USDTTRC20',
  account_number: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  account_holder_name: 'USDT · TRC20 (Tron)',
};

describe('POST /hooks/gp365/withdrawal', () => {
  it('looks up gp365 rows only, and settles one', async () => {
    const h = harness([usdtPayout]);
    const res = await run(
      withdrawal,
      h,
      message({
        MerchantCode: 'GP00001',
        CurrencyCode: 'USDT',
        MerchantTransactionId: 'PC-9',
        Status: 4,
        Amount: 91.3,
        NetAmount: 92.67,
      }),
    );
    expect(res.body).toBe('success');
    expect(h.packs.listGatewayWithdrawals).toHaveBeenCalledWith(
      { merchant_transaction_id: 'PC-9', gateway: 'gp365' },
      { take: 1 },
    );
    expect(h.packs.claimWithdrawalStatus).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'settled' }),
    );
    // The paid email and bell row carry the USDT the wallet got.
    expect(sendWithdrawalReceipt).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcome: 'paid',
        amount: 420,
        usdtAmount: 91.3,
      }),
    );
    expect(notifyFeed).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        template: 'withdrawal_paid',
        data: expect.objectContaining({ amount_myr: 420, usdt_amount: 91.3 }),
      }),
    );
  });
});

describe('POST /hooks/gp365/payout-verify', () => {
  const verifyData = (over: Record<string, unknown> = {}) => ({
    MerchantTransactionId: 'PC-9',
    Amount: 91.3,
    CurrencyCode: 'USDT',
    ...over,
  });

  it('approves the pending payout we submitted, in USDT', async () => {
    const h = harness([usdtPayout]);
    const res = await run(verify, h, message(verifyData()));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('success');
    expect(h.packs.listGatewayWithdrawals).toHaveBeenCalledWith(
      { merchant_transaction_id: 'PC-9', gateway: 'gp365' },
      { take: 1 },
    );
  });

  it('refuses another amount or currency', async () => {
    for (const over of [{ Amount: 91.31 }, { CurrencyCode: 'SGD' }]) {
      const h = harness([usdtPayout]);
      const res = await run(verify, h, message(verifyData(over)));
      expect(res.statusCode).toBe(400);
      expect(res.body).toBe('rejected');
    }
  });
});
