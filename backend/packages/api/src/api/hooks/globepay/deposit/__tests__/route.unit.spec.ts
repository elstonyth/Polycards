import { generateKeyPairSync } from 'node:crypto';
import { aesEncrypt, signPayload } from '../../../../../modules/packs/globepay';

// The feed receipt is a side effect, not the contract under test.
jest.mock('../../../../../modules/packs/notify-feed', () => ({
  notifyFeed: jest.fn().mockResolvedValue(undefined),
}));

import { POST } from '../route';
import { GLOBEPAY_MAX_RM } from '../../../../../modules/packs/globepay-deposit';

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
  // The route verifies inbound callbacks with THEIR key; here the test signs
  // as the gateway, so the "gateway public key" is this fixture's public half.
  process.env.GLOBEPAY_PUBLIC_KEY = publicKey;
});

/** Build a callback the way GlobePay365 does: AES payload + RSA-SHA1 over it. */
function callback(
  data: Record<string, unknown>,
  opts: { transactionId?: string; signWith?: string } = {},
) {
  const json = JSON.stringify(data);
  return {
    TransactionId: opts.transactionId ?? 'D2026072112415767',
    MerchantTransactionId: data.MerchantTransactionId,
    Data: aesEncrypt(json, AES_KEY),
    Signature: signPayload(json, opts.signWith ?? privateKey),
    Version: 0,
  };
}

const settled = {
  MerchantCode: 'Testpolycard',
  CurrencyCode: 'MYR',
  MerchantTransactionId: 'PG-1',
  Status: 6,
  Amount: 50,
  NetAmount: 48.5,
  PaymentMethodCode: 'BQR',
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
  id: 'gpd_1',
  customer_id: 'cus_1',
  merchant_transaction_id: 'PG-1',
  gateway_transaction_id: null,
  amount_requested: 50,
  // The method the TP ledger row is labelled with — the row is where the
  // route learns it, so the fixture has to carry it.
  payment_method_code: 'BQR',
  status: 'pending',
};

describe('deposit callback — authentication', () => {
  it('rejects a callback signed with the wrong key (no credit, no ack)', async () => {
    const attacker = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const h = harness(pendingRow);
    const res = await run(
      h,
      callback(settled, { signWith: attacker.privateKey }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toBe('success');
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('rejects a callback with a tampered amount', async () => {
    const h = harness(pendingRow);
    const honest = callback(settled);
    // Same signature, but the payload now says 999999.
    const forged = {
      ...honest,
      Data: aesEncrypt(JSON.stringify({ ...settled, Amount: 999999 }), AES_KEY),
    };
    const res = await run(h, forged);
    expect(res.statusCode).toBe(400);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('rejects a body with no Signature', async () => {
    const h = harness(pendingRow);
    const res = await run(h, { TransactionId: 'D1', Data: 'x' });
    expect(res.statusCode).toBe(400);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });
});

describe('deposit callback — ack contract', () => {
  it('acks status 6 and credits the customer', async () => {
    const h = harness(pendingRow);
    const res = await run(h, callback(settled));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('success');
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        customerId: 'cus_1',
        amount: 50,
        reason: 'topup',
        reference: 'D2026072112415767',
      }),
    );
  });

  // Conservation: a credit with no ledger row makes Σ(ledger) drift from the
  // balance (integration-tests/http/ledger-conservation.spec.ts). The route
  // must credit through the ledger-writing wrapper AND label the TP row with
  // the real method, not the mock default.
  it('labels the TP ledger row with the real method and their reference', async () => {
    const h = harness(pendingRow);
    await run(h, callback(settled));
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({
        ledgerPaymentMethod: pendingRow.payment_method_code,
        ledgerGatewayRef: 'D2026072112415767',
      }),
    );
  });

  it('credits the amount THEY confirmed, not the amount we requested', async () => {
    const h = harness({ ...pendingRow, amount_requested: 50 });
    // Customer actually paid 30.
    await run(h, callback({ ...settled, Amount: 30 }));
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 30 }),
    );
  });

  it('acks status 7 WITHOUT crediting — a dead deposit must not be retried forever', async () => {
    const h = harness(pendingRow);
    const res = await run(h, callback({ ...settled, Status: 7 }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('success');
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayDeposits).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: { id: 'gpd_1', status: 'pending' },
        data: expect.objectContaining({ status: 'failed' }),
      }),
    );
  });

  it('acks status 4 as a no-op — non-final, must not be marked failed', async () => {
    const h = harness(pendingRow);
    const res = await run(h, callback({ ...settled, Status: 4 }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('success');
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayDeposits).not.toHaveBeenCalled();
  });

  it('acks an unknown reference instead of retrying forever', async () => {
    const h = harness(null);
    const res = await run(h, callback(settled));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('success');
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalled();
  });

  it('does NOT ack when crediting throws, so the money still lands on retry', async () => {
    const h = harness(pendingRow);
    h.packs.topUpCreditsWithLedger.mockRejectedValue(new Error('lock timeout'));
    const res = await run(h, callback(settled));
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toBe('success');
  });

  it('refuses to credit a settled callback in another currency', async () => {
    const h = harness(pendingRow);
    // The ledger is Ringgit and credits 1:1 — 500 VND is not RM 500.
    const res = await run(h, callback({ ...settled, CurrencyCode: 'VND' }));
    expect(res.statusCode).toBe(400);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('refuses to credit a non-positive amount', async () => {
    const h = harness(pendingRow);
    const res = await run(h, callback({ ...settled, Amount: 0 }));
    expect(res.statusCode).toBe(400);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });
});

// The signature authenticates the SENDER, not the payee. MerchantCode is the
// only signed field that says the money is ours, and it was declared and never
// read — so a validly-signed callback describing a payment into another
// merchant account would have been credited to one of our customers.
describe('deposit callback — merchant code', () => {
  it('refuses a callback naming a different merchant', async () => {
    const h = harness(pendingRow);
    const res = await run(
      h,
      callback({ ...settled, MerchantCode: 'SomeoneElse' }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toBe('success');
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  // Checked before the row is even looked up: the CurrencyCode guard sits after
  // the status-7 branch, so a late check would let a foreign callback write one
  // of our live deposits off as failed before refusing it.
  it('refuses a foreign status 7 without writing our row off', async () => {
    const h = harness(pendingRow);
    const res = await run(
      h,
      callback({ ...settled, MerchantCode: 'SomeoneElse', Status: 7 }),
    );
    expect(res.statusCode).toBe(400);
    expect(h.packs.updateGlobePayDeposits).not.toHaveBeenCalled();
  });

  it('accepts a merchant code differing only in case — that is config drift, not an attack', async () => {
    const h = harness(pendingRow);
    const res = await run(
      h,
      callback({ ...settled, MerchantCode: 'TESTPOLYCARD' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('success');
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalled();
  });
});

// The ceiling. Not an equality check against amount_requested — a customer may
// legitimately pay a different sum — but nothing the gateway confirms may
// exceed what the submit path could ever have created.
describe('deposit callback — amount ceiling', () => {
  it('refuses an amount above the deposit ceiling and QUARANTINES the row', async () => {
    const h = harness(pendingRow);
    const res = await run(
      h,
      callback({ ...settled, Amount: GLOBEPAY_MAX_RM + 1 }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toBe('success');
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    // The row must stay 'pending': the customer may genuinely have paid, so
    // this is an operator alert, not a write-off. Marking it failed would turn
    // the alert into silent money loss.
    expect(h.packs.updateGlobePayDeposits).not.toHaveBeenCalled();
    expect(h.logger.error).toHaveBeenCalled();
  });

  it('still credits an amount exactly AT the ceiling', async () => {
    const h = harness(pendingRow);
    const res = await run(h, callback({ ...settled, Amount: GLOBEPAY_MAX_RM }));
    expect(res.statusCode).toBe(200);
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledWith(
      expect.objectContaining({ amount: GLOBEPAY_MAX_RM }),
    );
  });
});

describe('deposit callback — already-resolved rows', () => {
  it('ignores a late status 7 on an already-settled deposit', async () => {
    const h = harness({ ...pendingRow, status: 'settled' });
    const res = await run(h, callback({ ...settled, Status: 7 }));
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('success');
    // The credit stands; the row must not be flipped to failed under it.
    expect(h.packs.updateGlobePayDeposits).not.toHaveBeenCalled();
  });

  it('does not re-credit a settled deposit on a repeated status 6', async () => {
    const h = harness({ ...pendingRow, status: 'settled' });
    const res = await run(h, callback(settled));
    expect(res.body).toBe('success');
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  // THE money-losing case, and the one this suite used to have no test for.
  // The sweep can write a paid deposit off as 'failed' (a requery 400 read as
  // "never existed", or a non-final status older than GLOBEPAY_STALE_AFTER_MS)
  // and it only rescans status='pending', so the row never comes back. If the
  // customer's settlement callback is then swallowed here, the payment is gone
  // with no credit and no log — recoverable only by hand-diffing GlobePay's
  // back office against globepay_deposit.
  it('credits a status 6 that lands on a written-off (failed) row', async () => {
    const h = harness({ ...pendingRow, status: 'failed' });
    const res = await run(h, callback(settled));
    expect(res.statusCode).toBe(200);
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledTimes(1);
    // …and the row must follow the money. A selector hardcoded to 'pending'
    // would match nothing here, leaving the ledger credited and the row failed.
    expect(h.packs.updateGlobePayDeposits).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: { id: pendingRow.id, status: 'failed' },
        data: expect.objectContaining({ status: 'settled' }),
      }),
    );
    // Silent recovery is nearly as bad as silent loss — an operator has to know
    // the sweep wrote off a deposit the customer actually paid.
    expect(h.logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/already failed/i),
    );
  });

  // The inverse must NOT resurrect anything: a failure callback on a failed row
  // agrees with us, so it stays a plain ack with no ledger movement.
  it('acks a status 7 on a failed row without touching the ledger', async () => {
    const h = harness({ ...pendingRow, status: 'failed' });
    const res = await run(h, callback({ ...settled, Status: 7 }));
    expect(res.statusCode).toBe(200);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
    expect(h.packs.updateGlobePayDeposits).not.toHaveBeenCalled();
  });
});

// AdditionalInformationData carries the RECEIVING BANK DETAILS (§1.2.4) and is
// UNSIGNED — only `Data` is covered by the signature. It used to be decrypted
// straight into an info log line; logs have a wider access population and a
// longer retention than the database, so that put customer bank details
// somewhere they outlive the deposit row.
describe('deposit callback — bank details never reach the logs', () => {
  const BANK_DETAILS = JSON.stringify({
    BankName: 'Maybank',
    BankAccountNo: '5561234509876',
    BankAccountName: 'POLYCARDS SDN BHD',
  });

  it('credits normally but logs nothing from AdditionalInformationData', async () => {
    const h = harness(pendingRow);
    const res = await run(h, {
      ...callback(settled),
      AdditionalInformationData: aesEncrypt(BANK_DETAILS, AES_KEY),
    });
    // The credit path is untouched — this is a logging change, not a behaviour
    // change, so a green assertion here is what proves the deletion was safe.
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('success');
    expect(h.packs.topUpCreditsWithLedger).toHaveBeenCalledTimes(1);

    // Boolean, not .toContain()/.not.toHaveBeenCalled(): both pretty-print the
    // recorded arguments on failure, which here IS the decrypted bank-detail
    // string — so the failure message would leak into a public CI log exactly
    // the value this test exists to keep out of logs.
    const logged = [
      ...h.logger.info.mock.calls,
      ...h.logger.warn.mock.calls,
      ...h.logger.error.mock.calls,
    ]
      .flat()
      .join('\n');
    expect(logged.includes('5561234509876')).toBe(false);
    expect(logged.includes('Maybank')).toBe(false);
    // The route has no logger.info call left at all on any path — the deleted
    // block was the only one (verified against the source, not assumed).
    expect(h.logger.info.mock.calls.length).toBe(0);
  });
});

describe('deposit callback — idempotency', () => {
  it('anchors on the signed reference, so a retry dedupes', async () => {
    const h = harness(pendingRow);
    await run(h, callback(settled));
    await run(h, callback(settled));
    const [first, second] = h.packs.topUpCreditsWithLedger.mock.calls;
    expect(first[0].idempotencyReference).toBe(second[0].idempotencyReference);
  });

  // SECURITY REGRESSION. TransactionId sits OUTSIDE the signature, so anyone
  // holding one genuine callback body can vary it freely without invalidating
  // anything. While it fed the anchor, each replay computed a DIFFERENT anchor,
  // slipped the ledger dedupe, and minted another credit — one payment became
  // N. It would also have double-credited with no attacker at all, had the
  // gateway ever varied that id across its own retries.
  it('ignores the unsigned TransactionId when anchoring — varying it cannot double-credit', async () => {
    const h = harness(pendingRow);
    await run(h, callback(settled, { transactionId: 'D-1' }));
    await run(h, callback(settled, { transactionId: 'D-ATTACKER-2' }));
    await run(h, callback(settled, { transactionId: 'D-ATTACKER-3' }));

    const anchors = h.packs.topUpCreditsWithLedger.mock.calls.map(
      (c: [{ idempotencyReference: string }]) => c[0].idempotencyReference,
    );
    expect(new Set(anchors).size).toBe(1);
  });

  it('uses a DIFFERENT anchor for a genuinely different deposit', async () => {
    const h = harness(pendingRow);
    await run(h, callback(settled));
    await run(h, callback({ ...settled, MerchantTransactionId: 'PG-2' }));
    const [first, second] = h.packs.topUpCreditsWithLedger.mock.calls;
    expect(first[0].idempotencyReference).not.toBe(
      second[0].idempotencyReference,
    );
  });

  it('rejects a callback whose SIGNED payload carries no MerchantTransactionId', async () => {
    const h = harness(pendingRow);
    const { MerchantTransactionId: _drop, ...unsignedOnly } = settled;
    // The unsigned envelope still names a real deposit — it must not be trusted
    // to select the row, and therefore the customer, that gets credited.
    const res = await run(h, {
      ...callback(unsignedOnly),
      MerchantTransactionId: 'PG-1',
    });
    expect(res.statusCode).toBe(400);
    expect(h.packs.topUpCreditsWithLedger).not.toHaveBeenCalled();
  });

  it('claims the row only while it is still pending', async () => {
    const h = harness(pendingRow);
    await run(h, callback(settled));
    expect(h.packs.updateGlobePayDeposits).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: { id: 'gpd_1', status: 'pending' },
      }),
    );
  });
});
