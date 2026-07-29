import { generateKeyPairSync } from 'node:crypto';
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { aesEncrypt, signPayload } from '../../src/modules/packs/globepay';
import {
  withdrawalIdempotencyReference,
  withdrawalRefundReference,
} from '../../src/modules/packs/globepay-withdrawal';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// GlobePay365 withdrawal (payout) loop, end to end against a booted server and
// a real database. Proves what the unit specs cannot: the hook is reachable
// without any auth header, the debit/refund really move the ledger, and a
// retried failure callback refunds exactly once. The submit half is exercised
// through the module (not the gateway) — SubmitWithdrawal itself needs the
// provider's payout channel, which staging has not activated.

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const AES_KEY = 'integration-aes-key';
const CUSTOMER_ID = 'cus_globepay_wd_integration';

process.env.GLOBEPAY_ENABLED = 'true';
process.env.GLOBEPAY_WITHDRAWALS_ENABLED = 'true';
// No default for the host (globepayConfigFromEnv): the booted server's
// callback routes 500 without it, and CI has no .env to fall back on.
process.env.GLOBEPAY_API_BASE = 'https://mapi.example.test';
process.env.GLOBEPAY_MERCHANT_CODE = 'Testpolycard';
process.env.GLOBEPAY_AES_KEY = AES_KEY;
process.env.GLOBEPAY_MERCHANT_PRIVATE_KEY = privateKey;
// The routes verify inbound callbacks with THEIR key; the test plays gateway.
process.env.GLOBEPAY_PUBLIC_KEY = publicKey;

const callback = (
  data: Record<string, unknown>,
  opts: { transactionId?: string; signWith?: string } = {},
) => {
  const json = JSON.stringify(data);
  return {
    TransactionId: opts.transactionId ?? 'W2026072200000001',
    MerchantTransactionId: data.MerchantTransactionId,
    Data: aesEncrypt(json, AES_KEY),
    Signature: signPayload(json, opts.signWith ?? privateKey),
    Version: 0,
  };
};

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GlobePay365 withdrawal loop', () => {
      const packs = () =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);

      let seq = 0;

      /** Fund the customer, then debit + seed the pending payout row exactly
       * as startGlobePayWithdrawal does after a successful submit. */
      const seedWithdrawal = async (
        merchantTransactionId: string,
        amount = 50,
      ) => {
        await packs().mutateCreditAtomic({
          customerId: CUSTOMER_ID,
          amount,
          reason: 'topup',
          idempotencyReference: `wd-int-fund:${merchantTransactionId}`,
        });
        const debit = await packs().mutateCreditAtomic({
          customerId: CUSTOMER_ID,
          amount: -amount,
          reason: 'cashout',
          reference: merchantTransactionId,
          idempotencyReference: withdrawalIdempotencyReference(
            CUSTOMER_ID,
            merchantTransactionId,
          ),
          floor: 0,
        });
        const [row] = await packs().createGlobePayWithdrawals([
          {
            merchant_transaction_id: merchantTransactionId,
            customer_id: CUSTOMER_ID,
            amount,
            bank_code: 'MBB',
            account_number: '1234567890',
            account_holder_name: 'AHMAD BIN ALI',
            status: 'pending',
          },
        ]);
        return { row, balanceAfterDebit: debit.balance };
      };

      const balance = async () => {
        const rows = await packs().listCreditTransactions(
          { customer_id: CUSTOMER_ID },
          { take: 200 },
        );
        return rows.reduce((sum, r) => sum + Number(r.amount), 0);
      };

      const post = (body: unknown) =>
        unwrapResponse(api.post('/hooks/globepay/withdrawal', body));

      // POLYCARD-BACK §5 rows for money leaving by payout.
      const wdEntries = async () =>
        packs().listLedgerEntries(
          { customer_id: CUSTOMER_ID, type: 'WD' },
          { take: 100 },
        );

      const result = (
        merchantTransactionId: string,
        status: number,
        over = {},
      ) => ({
        MerchantCode: 'Testpolycard',
        CurrencyCode: 'MYR',
        MerchantTransactionId: merchantTransactionId,
        Status: status,
        Amount: 50,
        NetAmount: 49,
        PaymentMethodCode: 'WD',
        ...over,
      });

      it('is reachable with NO auth token and NO publishable key', async () => {
        const res = await post({ Data: 'nonsense', Signature: 'nope' });
        expect(res.status).toBe(400);
        expect(res.data).not.toBe('success');
      });

      it('status 4 settles the row and leaves the balance debited', async () => {
        const mtid = `PC-wd-int-settle-${++seq}`;
        const { row, balanceAfterDebit } = await seedWithdrawal(mtid);

        const res = await post(callback(result(mtid, 4)));
        expect(res.status).toBe(200);
        expect(res.data).toBe('success');

        const [after] = await packs().listGlobePayWithdrawals(
          { id: row.id },
          { take: 1 },
        );
        expect(after.status).toBe('settled');
        expect(after.gateway_status).toBe(4);
        expect(after.settled_at).toBeTruthy();
        // The money is gone from the balance — paid out, not refunded.
        expect(await balance()).toBe(balanceAfterDebit);
      });

      it('status 5 refunds the debit against the real ledger', async () => {
        const mtid = `PC-wd-int-refund-${++seq}`;
        const { row, balanceAfterDebit } = await seedWithdrawal(mtid);
        // WD rows accumulate across this describe (one customer), so the
        // assertion below is a delta rather than a total.
        const wdBefore = await wdEntries();

        const res = await post(callback(result(mtid, 5)));
        expect(res.status).toBe(200);
        expect(res.data).toBe('success');

        const [after] = await packs().listGlobePayWithdrawals(
          { id: row.id },
          { take: 1 },
        );
        expect(after.status).toBe('failed');
        // The full amount came back.
        expect(await balance()).toBe(balanceAfterDebit + 50);
        const refundRows = await packs().listCreditTransactions(
          {
            customer_id: CUSTOMER_ID,
            source_transaction_id: withdrawalRefundReference(CUSTOMER_ID, mtid),
          },
          { take: 5 },
        );
        expect(refundRows).toHaveLength(1);
        expect(Number(refundRows[0].amount)).toBe(50);

        // The paired WD row. Money leaving (and coming back) by payout has to
        // appear in the POLYCARD-BACK ledger or Σ(ledger) drifts from the
        // balance the moment payouts are armed. The refund is the only half
        // this route owns — the debit's row is written by
        // startGlobePayWithdrawal, which this spec seeds directly.
        const wdAfter = await wdEntries();
        const fresh = wdAfter.filter(
          (e: { id: string }) => !wdBefore.some((b: { id: string }) => b.id === e.id),
        );
        expect(fresh).toHaveLength(1);
        expect(Number(fresh[0].wallet_delta)).toBe(50);
        expect(fresh[0].payload).toMatchObject({
          type: 'WD',
          outcome: 'refunded',
        });
      });

      it('a retried failure callback refunds exactly once — even with a varied unsigned TransactionId', async () => {
        const mtid = `PC-wd-int-refund-retry-${++seq}`;
        const { balanceAfterDebit } = await seedWithdrawal(mtid);

        const body = result(mtid, 5);
        expect(
          (await post(callback(body, { transactionId: 'W-1' }))).data,
        ).toBe('success');
        expect(
          (await post(callback(body, { transactionId: 'W-ATTACKER-2' }))).data,
        ).toBe('success');
        expect(
          (await post(callback(body, { transactionId: 'W-ATTACKER-3' }))).data,
        ).toBe('success');

        // One refund, not three: an attacker replaying a genuine failure
        // callback cannot mint credit.
        expect(await balance()).toBe(balanceAfterDebit + 50);
      });

      it('a late status 5 after settlement does NOT refund paid-out money', async () => {
        const mtid = `PC-wd-int-late-fail-${++seq}`;
        const { balanceAfterDebit } = await seedWithdrawal(mtid);

        expect((await post(callback(result(mtid, 4)))).data).toBe('success');
        expect((await post(callback(result(mtid, 5)))).data).toBe('success');

        // Settled first, so the money left; the late failure must not also
        // hand the balance back — that would pay the customer twice.
        expect(await balance()).toBe(balanceAfterDebit);
      });

      it('payout verification approves our pending payout and refuses a tampered amount', async () => {
        const mtid = `PC-wd-int-verify-${++seq}`;
        await seedWithdrawal(mtid);

        const verify = (amount: number) => {
          const json = JSON.stringify({
            MerchantCode: 'Testpolycard',
            CurrencyCode: 'MYR',
            MerchantTransactionId: mtid,
            Amount: amount,
          });
          return unwrapResponse(
            api.post('/hooks/globepay/payout-verify', {
              MerchantCode: 'Testpolycard',
              Data: aesEncrypt(json, AES_KEY),
              Signature: signPayload(json, privateKey),
              Version: 0,
            }),
          );
        };

        expect((await verify(50)).data).toBe('success');
        const tampered = await verify(500);
        expect(tampered.status).toBe(400);
        expect(tampered.data).not.toBe('success');
      });

      it('the store submit route refuses an unauthenticated request', async () => {
        const res = await unwrapResponse(
          api.post('/store/credits/withdraw', { amount: 50 }),
        );
        // 400 = publishable-key middleware, 401 = authenticate() — either
        // gate rejecting is fine; what must never happen is the route running.
        expect([400, 401]).toContain(res.status);
      });
    });
  },
});
