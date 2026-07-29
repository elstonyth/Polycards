import { generateKeyPairSync } from 'node:crypto';
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { aesEncrypt, signPayload } from '../../src/modules/packs/globepay';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// GlobePay365 deposit callback, end to end against a booted server and a real
// database. The unit specs mock the service layer; this proves the parts they
// cannot: that /hooks/* is reachable WITHOUT a customer token or publishable
// key, that the row lookup and the ledger write actually happen, and that a
// retried callback does not double-credit.
//
// The only thing still unproven after this is GlobePay365's own signature
// bytes — here the test signs as the gateway using a throwaway keypair.

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const AES_KEY = 'integration-aes-key';
const CUSTOMER_ID = 'cus_globepay_integration';

process.env.GLOBEPAY_ENABLED = 'true';
// No default for the host (globepayConfigFromEnv): the booted server's
// callback routes 500 without it, and CI has no .env to fall back on.
process.env.GLOBEPAY_API_BASE = 'https://mapi.example.test';
process.env.GLOBEPAY_MERCHANT_CODE = 'Testpolycard';
process.env.GLOBEPAY_AES_KEY = AES_KEY;
process.env.GLOBEPAY_MERCHANT_PRIVATE_KEY = privateKey;
// The route verifies inbound callbacks with THEIR key; the test plays gateway.
process.env.GLOBEPAY_PUBLIC_KEY = publicKey;

/** Build a callback exactly as GlobePay365 does (§1.2.2), PascalCase included. */
const callback = (
  data: Record<string, unknown>,
  opts: { transactionId?: string; signWith?: string } = {},
) => {
  const json = JSON.stringify(data);
  return {
    TransactionId: opts.transactionId ?? 'D2026072112415767',
    MerchantTransactionId: data.MerchantTransactionId,
    Data: aesEncrypt(json, AES_KEY),
    Signature: signPayload(json, opts.signWith ?? privateKey),
    Version: 0,
  };
};

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GlobePay365 deposit callback', () => {
      const packs = () =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);

      /** A pending deposit, as the submit route would have written it. */
      const seedDeposit = async (merchantTransactionId: string) => {
        const [row] = await packs().createGlobePayDeposits([
          {
            merchant_transaction_id: merchantTransactionId,
            customer_id: CUSTOMER_ID,
            amount_requested: 50,
            payment_method_code: 'BQR',
            status: 'pending',
          },
        ]);
        return row;
      };

      const ledger = async () =>
        packs().listCreditTransactions(
          { customer_id: CUSTOMER_ID },
          { take: 50 },
        );

      // POLYCARD-BACK §5 rows, as opposed to `ledger()` above which reads the
      // credit_transaction balance ledger. Both must move together.
      const entries = async () =>
        packs().listLedgerEntries({ customer_id: CUSTOMER_ID }, { take: 50 });

      const post = (body: unknown) =>
        unwrapResponse(api.post('/hooks/globepay/deposit', body));

      const settled = (merchantTransactionId: string, over = {}) => ({
        MerchantCode: 'Testpolycard',
        CurrencyCode: 'MYR',
        MerchantTransactionId: merchantTransactionId,
        Status: 6,
        Amount: 50,
        NetAmount: 48.5,
        PaymentMethodCode: 'BQR',
        ...over,
      });

      it('is reachable with NO auth token and NO publishable key', async () => {
        // A webhook sends neither. If this 401s or 400s, the route is sitting
        // behind the store middleware and every real callback would be lost.
        const res = await post({ Data: 'nonsense', Signature: 'nope' });
        expect(res.status).toBe(400);
        expect(res.data).not.toBe('success');
      });

      it('credits the ledger on a verified status 6 and marks the row settled', async () => {
        const mtid = 'PC-integration-settle';
        const row = await seedDeposit(mtid);

        const res = await post(callback(settled(mtid)));
        expect(res.status).toBe(200);
        expect(res.data).toBe('success');

        const rows = await ledger();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          reason: 'topup',
          pull_id: null,
          reference: 'D2026072112415767',
        });
        expect(Number(rows[0].amount)).toBe(50);

        // The paired TP row, written in the SAME transaction as the credit.
        // Without it Σ(ledger_entry) drifts from the balance on every real
        // deposit — the conservation invariant only ever exercised the mock.
        const ledgerRows = await entries();
        expect(ledgerRows).toHaveLength(1);
        expect(ledgerRows[0].type).toBe('TP');
        expect(Number(ledgerRows[0].wallet_delta)).toBe(50);
        expect(ledgerRows[0].payload).toMatchObject({
          type: 'TP',
          // The REAL method off the deposit row, not the mock default.
          payment_method: 'BQR',
          gateway_ref: 'D2026072112415767',
        });

        const [after] = await packs().listGlobePayDeposits(
          { id: row.id },
          { take: 1 },
        );
        expect(after.status).toBe('settled');
        expect(after.gateway_status).toBe(6);
        expect(Number(after.amount_settled)).toBe(50);
        expect(after.settled_at).toBeTruthy();
      });

      it('writes exactly ONE ledger row when the callback is retried', async () => {
        const mtid = 'PC-integration-ledger-retry';
        await seedDeposit(mtid);
        await post(callback(settled(mtid)));
        await post(callback(settled(mtid)));
        // Same idempotency anchor collapses to one credit, and refId is that
        // credit's id, so the ledger cannot double either.
        expect(await entries()).toHaveLength(1);
      });

      it('does not double-credit when the same callback is retried', async () => {
        const mtid = 'PC-integration-retry';
        await seedDeposit(mtid);

        const body = callback(settled(mtid));
        expect((await post(body)).data).toBe('success');
        expect((await post(body)).data).toBe('success');

        const rows = await ledger();
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].amount)).toBe(50);
      });

      // SECURITY REGRESSION, against the real ledger. TransactionId is OUTSIDE
      // the signature, so a captured callback body can be replayed with that
      // field varied and the signature still verifies. While the idempotency
      // anchor was derived from it, each replay produced a fresh anchor, missed
      // the dedupe, and appended another credit — one payment minting many.
      it('cannot be double-credited by replaying with a varied unsigned TransactionId', async () => {
        const mtid = 'PC-integration-varied-txid';
        await seedDeposit(mtid);
        const body = settled(mtid);

        expect(
          (await post(callback(body, { transactionId: 'D-1' }))).data,
        ).toBe('success');
        await post(callback(body, { transactionId: 'D-ATTACKER-2' }));
        await post(callback(body, { transactionId: 'D-ATTACKER-3' }));

        const rows = await ledger();
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].amount)).toBe(50);
      });

      it('rejects a callback whose signed payload has no MerchantTransactionId', async () => {
        const mtid = 'PC-integration-unsigned-ref';
        await seedDeposit(mtid);
        const { MerchantTransactionId: _drop, ...unsignedOnly } = settled(mtid);

        // Signed payload omits the reference; the unsigned envelope supplies a
        // real one. It must not be trusted to pick the row to credit.
        const res = await post({
          ...callback(unsignedOnly),
          MerchantTransactionId: mtid,
        });
        expect(res.status).toBe(400);
        expect(await ledger()).toHaveLength(0);
      });

      it('credits what the customer actually paid, not what we requested', async () => {
        const mtid = 'PC-integration-partial';
        await seedDeposit(mtid);

        // Row asked for 50; the callback says 30.
        await post(callback(settled(mtid, { Amount: 30 })));

        const rows = await ledger();
        expect(Number(rows[0].amount)).toBe(30);
      });

      it('writes NOTHING for a forged signature', async () => {
        const mtid = 'PC-integration-forged';
        const row = await seedDeposit(mtid);
        const attacker = generateKeyPairSync('rsa', {
          modulusLength: 2048,
          privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
          publicKeyEncoding: { type: 'spki', format: 'pem' },
        });

        const res = await post(
          callback(settled(mtid), { signWith: attacker.privateKey }),
        );
        expect(res.status).toBe(400);
        expect(await ledger()).toHaveLength(0);
        const [after] = await packs().listGlobePayDeposits(
          { id: row.id },
          { take: 1 },
        );
        expect(after.status).toBe('pending');
      });

      it('acks status 7 without crediting, and marks the row failed', async () => {
        const mtid = 'PC-integration-failed';
        const row = await seedDeposit(mtid);

        const res = await post(callback(settled(mtid, { Status: 7 })));
        expect(res.status).toBe(200);
        expect(res.data).toBe('success');
        expect(await ledger()).toHaveLength(0);

        const [after] = await packs().listGlobePayDeposits(
          { id: row.id },
          { take: 1 },
        );
        expect(after.status).toBe('failed');
      });

      it('leaves a status 4 row pending — it can still settle later', async () => {
        const mtid = 'PC-integration-pending';
        const row = await seedDeposit(mtid);

        expect((await post(callback(settled(mtid, { Status: 4 })))).data).toBe(
          'success',
        );
        expect(await ledger()).toHaveLength(0);

        const [after] = await packs().listGlobePayDeposits(
          { id: row.id },
          { take: 1 },
        );
        expect(after.status).toBe('pending');

        // ...and the later real settlement still credits.
        await post(callback(settled(mtid)));
        expect(await ledger()).toHaveLength(1);
      });

      it('acks an unknown reference without writing anything', async () => {
        const res = await post(callback(settled('PC-does-not-exist')));
        expect(res.status).toBe(200);
        expect(res.data).toBe('success');
        expect(await ledger()).toHaveLength(0);
      });
    });
  },
});
