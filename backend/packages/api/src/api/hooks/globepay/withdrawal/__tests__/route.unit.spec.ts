import { generateKeyPairSync } from 'node:crypto';
import { aesEncrypt, signPayload } from '../../../../../modules/packs/globepay';

// The feed receipt is a side effect, not the contract under test.
jest.mock('../../../../../modules/packs/notify-feed', () => ({
  notifyFeed: jest.fn().mockResolvedValue(undefined),
}));

import { POST } from '../route';
import { withdrawalRefundReference } from '../../../../../modules/packs/globepay-withdrawal';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const AES_KEY = 'test-aes-key';

beforeEach(() => {
  // The host has no default (see globepayConfigFromEnv): CI has no .env,
  // so a spec that leans on an ambient value passes locally and fails there.
  process.env.GLOBEPAY_API_BASE = 'https://mapi.example.test';
  process.env.GLOBEPAY_MERCHANT_CODE = 'Testpolycard';
  process.env.GLOBEPAY_AES_KEY = AES_KEY;
  process.env.GLOBEPAY_MERCHANT_PRIVATE_KEY = privateKey;
  process.env.GLOBEPAY_PUBLIC_KEY = publicKey;
});

/** Build a withdrawal callback the way GlobePay365 does. */
function callback(
  data: Record<string, unknown>,
  opts: { transactionId?: string; signWith?: string } = {},
) {
  const json = JSON.stringify(data);
  return {
    TransactionId: opts.transactionId ?? 'W2026072200000001',
    MerchantTransactionId: data.MerchantTransactionId,
    Data: aesEncrypt(json, AES_KEY),
    Signature: signPayload(json, opts.signWith ?? privateKey),
    Version: 0,
  };
}

// Withdrawal status: 4 = success, 5 = fail (INVERTED vs deposits, where
// 4 is the non-final VerifyFail — an easy source of catastrophic mapping bugs,
// pinned here on both sides).
const paid = {
  MerchantCode: 'Testpolycard',
  CurrencyCode: 'MYR',
  MerchantTransactionId: 'PC-W1',
  Status: 4,
  Amount: 50,
  NetAmount: 49,
  PaymentMethodCode: 'WD',
};

function harness(withdrawal: Record<string, unknown> | null) {
  const packs = {
    listGlobePayWithdrawals: jest
      .fn()
      .mockResolvedValue(withdrawal ? [withdrawal] : []),
    updateGlobePayWithdrawals: jest.fn().mockResolvedValue(undefined),
    withdrawCreditsWithLedger: jest.fn().mockResolvedValue({
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
    scope: { resolve: (k: string) => (k === 'logger' ? logger : packs) },
  } as never;
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
) => {
  (h.req as { body: unknown }).body = body;
  await POST(h.req, h.res as never);
  return h.res;
};

const pendingRow = {
  id: 'gpw_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PC-W1',
  gateway_transaction_id: null,
  amount: 50,
  status: 'pending',
};

describe('withdrawal callback — authentication', () => {
  it('rejects a callback signed with the wrong key (nothing changes, no ack)', async () => {
    const attacker = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const h = harness(pendingRow);
    const res = await run(h, callback(paid, { signWith: attacker.privateKey }));
    expect(res.statusCode).toBe(400);
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
  });

  it('rejects a body with no Signature', async () => {
    const h = harness(pendingRow);
    const res = await run(h, { TransactionId: 'W1', Data: 'x' });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a callback whose SIGNED payload carries no MerchantTransactionId', async () => {
    const h = harness(pendingRow);
    const { MerchantTransactionId: _drop, ...unsignedOnly } = paid;
    const res = await run(h, {
      ...callback(unsignedOnly),
      MerchantTransactionId: 'PC-W1',
    });
    expect(res.statusCode).toBe(400);
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
  });
});

describe('withdrawal callback — status 4 (paid)', () => {
  it('settles the row WITHOUT touching the ledger — the debit already happened', async () => {
    const h = harness(pendingRow);
    const res = await run(h, callback(paid));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('success');
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: { id: 'gpw_1', status: 'pending' },
        data: expect.objectContaining({ status: 'settled', gateway_status: 4 }),
      }),
    );
  });

  it('logs loudly when their settled Amount disagrees with the debit', async () => {
    const h = harness(pendingRow);
    await run(h, callback({ ...paid, Amount: 45 }));
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('settled at 45'),
    );
    // Still settles — the discrepancy is a support case, not a reason to
    // leave the row pending forever.
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalled();
  });
});

describe('withdrawal callback — status 5 (failed) refunds', () => {
  it('refunds the debit on the wd-refund: anchor and closes the row', async () => {
    const h = harness(pendingRow);
    const res = await run(h, callback({ ...paid, Status: 5 }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('success');
    expect(h.packs.withdrawCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_1',
        amount: 50,
        reason: 'cashout',
        idempotencyReference: withdrawalRefundReference('cus_1', 'PC-W1'),
      }),
    );
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: { id: 'gpw_1', status: 'pending' },
        data: expect.objectContaining({ status: 'failed', gateway_status: 5 }),
      }),
    );
  });

  it('a retried failure callback computes the SAME refund anchor — one refund, ever', async () => {
    const h = harness(pendingRow);
    await run(h, callback({ ...paid, Status: 5 }, { transactionId: 'W-1' }));
    await run(
      h,
      callback({ ...paid, Status: 5 }, { transactionId: 'W-VARIED-2' }),
    );
    const anchors = h.packs.withdrawCreditsWithLedger.mock.calls.map(
      (c: [{ idempotencyReference: string }]) => c[0].idempotencyReference,
    );
    expect(new Set(anchors).size).toBe(1);
  });

  it('does NOT ack when the refund throws, so the money comes back on retry', async () => {
    const h = harness(pendingRow);
    h.packs.withdrawCreditsWithLedger.mockRejectedValue(new Error('lock timeout'));
    const res = await run(h, callback({ ...paid, Status: 5 }));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toBe('success');
    // Row must stay pending so the retry (or the sweep) can refund.
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
  });
});

describe('withdrawal callback — non-final and edge states', () => {
  it('acks a processing status as a no-op', async () => {
    const h = harness(pendingRow);
    const res = await run(h, callback({ ...paid, Status: 2 }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('success');
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
  });

  it('acks an unknown reference instead of retrying forever', async () => {
    const h = harness(null);
    const res = await run(h, callback(paid));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('success');
    expect(h.logger.error).toHaveBeenCalled();
  });

  it('ignores a late status 5 on an already-settled payout — no refund of paid money', async () => {
    const h = harness({ ...pendingRow, status: 'settled' });
    const res = await run(h, callback({ ...paid, Status: 5 }));
    expect(res.body).toBe('success');
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
  });

  it('does not re-process an already-failed payout on a repeated status 5', async () => {
    const h = harness({ ...pendingRow, status: 'failed' });
    const res = await run(h, callback({ ...paid, Status: 5 }));
    expect(res.body).toBe('success');
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
  });

  // Same guard as the deposit hook: the signature proves GlobePay sent it, not
  // that the payout is ours. Checked before the row lookup, so a foreign
  // callback cannot settle or refund one of our rows.
  it('refuses a callback naming a different merchant', async () => {
    const h = harness(pendingRow);
    const res = await run(
      h,
      callback({ ...paid, MerchantCode: 'SomeoneElse' }),
    );
    expect(res.statusCode).toBe(400);
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
  });

  it('accepts a merchant code differing only in case', async () => {
    const h = harness(pendingRow);
    const res = await run(
      h,
      callback({ ...paid, MerchantCode: 'TESTPOLYCARD' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('success');
    expect(h.packs.updateGlobePayWithdrawals).toHaveBeenCalled();
  });

  it('refuses a final callback in another currency', async () => {
    const h = harness(pendingRow);
    const res = await run(h, callback({ ...paid, CurrencyCode: 'VND' }));
    expect(res.statusCode).toBe(400);
    expect(h.packs.withdrawCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayWithdrawals).not.toHaveBeenCalled();
  });
});
