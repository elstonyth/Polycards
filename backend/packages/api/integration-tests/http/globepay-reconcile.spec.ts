import { generateKeyPairSync } from 'node:crypto';
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { aesEncrypt, signPayload } from '../../src/modules/packs/globepay';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// The reconciliation sweep against a real database. Its whole reason to exist
// is the callback that never arrives: without it a customer pays, the POST is
// dropped, and nothing in the system ever notices.
//
// getDepositDetail is the only mocked seam — it is the gateway's HTTP endpoint.
// Everything else (ledger, locking, idempotency, the deposit row) is real.
jest.mock('../../src/modules/packs/globepay-client', () => {
  const actual = jest.requireActual('../../src/modules/packs/globepay-client');
  return { ...actual, getDepositDetail: jest.fn() };
});

import { getDepositDetail } from '../../src/modules/packs/globepay-client';
import globepayReconcileJob from '../../src/jobs/globepay-reconcile';
import { GLOBEPAY_STALE_AFTER_MS } from '../../src/modules/packs/globepay-reconcile';

const requery = getDepositDetail as jest.Mock;

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 1024,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const AES_KEY = 'integration-aes-key';
const CUSTOMER_ID = 'cus_globepay_reconcile';

process.env.GLOBEPAY_ENABLED = 'true';
process.env.GLOBEPAY_MERCHANT_CODE = 'Testpolycard';
process.env.GLOBEPAY_AES_KEY = AES_KEY;
process.env.GLOBEPAY_MERCHANT_PRIVATE_KEY = privateKey;
process.env.GLOBEPAY_PUBLIC_KEY = publicKey;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GlobePay365 reconciliation sweep', () => {
      const packs = () =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);

      beforeEach(() => requery.mockReset());

      const seed = async (mtid: string, ageMs = 0) => {
        const [row] = await packs().createGlobePayDeposits([
          {
            merchant_transaction_id: mtid,
            customer_id: CUSTOMER_ID,
            amount_requested: 50,
            payment_method_code: 'BQR',
            status: 'pending',
          },
        ]);
        if (ageMs > 0) {
          // Backdate so the stale window applies without waiting an hour.
          await packs().updateGlobePayDeposits({
            id: row.id,
            created_at: new Date(Date.now() - ageMs),
          } as never);
        }
        return row;
      };

      const sweep = () => globepayReconcileJob(getContainer() as never);

      const ledger = async () =>
        packs().listCreditTransactions(
          { customer_id: CUSTOMER_ID },
          { take: 50 },
        );

      const rowOf = async (id: string) =>
        (await packs().listGlobePayDeposits({ id }, { take: 1 }))[0];

      it('credits a deposit whose callback never arrived', async () => {
        const row = await seed('PC-reconcile-dropped');
        requery.mockResolvedValue({
          state: 'success',
          amount: 50,
          statusId: 6,
        });

        await sweep();

        const rows = await ledger();
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].amount)).toBe(50);
        expect(rows[0].reason).toBe('topup');
        expect((await rowOf(row.id)).status).toBe('settled');
      });

      it('credits the amount the GATEWAY reports, not the one we requested', async () => {
        await seed('PC-reconcile-partial');
        requery.mockResolvedValue({
          state: 'success',
          amount: 30,
          statusId: 6,
        });

        await sweep();
        expect(Number((await ledger())[0].amount)).toBe(30);
      });

      it('does not double-credit when the callback arrives after the sweep', async () => {
        const mtid = 'PC-reconcile-then-callback';
        await seed(mtid);
        requery.mockResolvedValue({
          state: 'success',
          amount: 50,
          statusId: 6,
        });

        await sweep();

        // The "lost" callback finally lands. It shares the sweep's idempotency
        // anchor (the signed MerchantTransactionId), so it must credit nothing.
        const json = JSON.stringify({
          MerchantCode: 'Testpolycard',
          CurrencyCode: 'MYR',
          MerchantTransactionId: mtid,
          Status: 6,
          Amount: 50,
          NetAmount: 50,
        });
        const res = await unwrapResponse(
          api.post('/hooks/globepay/deposit', {
            TransactionId: 'D-late',
            MerchantTransactionId: mtid,
            Data: aesEncrypt(json, AES_KEY),
            Signature: signPayload(json, privateKey),
            Version: 0,
          }),
        );
        expect(res.status).toBe(200);

        const rows = await ledger();
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].amount)).toBe(50);
      });

      it('running the sweep twice credits once', async () => {
        await seed('PC-reconcile-twice');
        requery.mockResolvedValue({
          state: 'success',
          amount: 50,
          statusId: 6,
        });

        await sweep();
        await sweep();

        expect(await ledger()).toHaveLength(1);
      });

      it('closes a deposit the gateway reports as failed, crediting nothing', async () => {
        const row = await seed('PC-reconcile-failed');
        requery.mockResolvedValue({ state: 'failed', amount: 50, statusId: 7 });

        await sweep();

        expect(await ledger()).toHaveLength(0);
        expect((await rowOf(row.id)).status).toBe('failed');
      });

      it('leaves a recent non-final deposit pending', async () => {
        const row = await seed('PC-reconcile-young');
        requery.mockResolvedValue({
          state: 'pending',
          amount: 50,
          statusId: 4,
        });

        await sweep();

        expect(await ledger()).toHaveLength(0);
        expect((await rowOf(row.id)).status).toBe('pending');
      });

      it('expires a non-final deposit past the stale window', async () => {
        const row = await seed(
          'PC-reconcile-stale',
          GLOBEPAY_STALE_AFTER_MS + 60_000,
        );
        requery.mockResolvedValue({
          state: 'pending',
          amount: 50,
          statusId: 4,
        });

        await sweep();

        expect(await ledger()).toHaveLength(0);
        expect((await rowOf(row.id)).status).toBe('failed');
      });

      it('keeps sweeping after one deposit errors', async () => {
        const bad = await seed('PC-reconcile-boom');
        const good = await seed('PC-reconcile-after-boom');
        requery.mockImplementation(async (mtid: string) => {
          if (mtid === bad.merchant_transaction_id)
            throw new Error('gateway 500');
          return { state: 'success', amount: 50, statusId: 6 };
        });

        await sweep();

        // The failure must not strand the customer behind it in the queue.
        expect(await ledger()).toHaveLength(1);
        expect((await rowOf(good.id)).status).toBe('settled');
        expect((await rowOf(bad.id)).status).toBe('pending');
      });
    });
  },
});
