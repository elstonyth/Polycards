import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import {
  withdrawalIdempotencyReference,
  withdrawalRefundReference,
} from '../../src/modules/packs/globepay-withdrawal';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// TGPay callbacks, end to end against a booted server and a real database.
// The unit specs mock the service layer; this proves the parts they cannot:
// that /hooks/tgpay/* is reachable WITHOUT a customer token or publishable
// key, that the row lookup and the ledger writes actually happen, that a
// retried callback does not double-credit, and that a payout rejection
// refunds the real ledger exactly once.
//
// The test plays gateway with the key pair below (TGPay authenticates its
// callbacks with the same two headers we send outbound). The sandbox base
// keeps the source-IP allowlist header-only, as it is on the real sandbox.

const CUSTOMER_ID = 'cus_tgpay_integration';
const AUTH = { 'x-public-key': 'pk-int', 'x-secret-key': 'sk-int' };

process.env.GLOBEPAY_ENABLED = 'true';
process.env.GLOBEPAY_WITHDRAWALS_ENABLED = 'true';
process.env.PAYMENT_GATEWAY = 'tgpay';
process.env.PAYMENT_CALLBACK_BASE = 'https://backend.example.test';
process.env.TGPAY_API_BASE = 'https://sandbox-api.example.test/api/v2';
process.env.TGPAY_PUBLIC_KEY = AUTH['x-public-key'];
process.env.TGPAY_SECRET_KEY = AUTH['x-secret-key'];
delete process.env.TGPAY_CALLBACK_IPS;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    const packs = () =>
      getContainer().resolve<PacksModuleService>(PACKS_MODULE);

    const ledger = async () =>
      packs().listCreditTransactions(
        { customer_id: CUSTOMER_ID },
        { take: 200 },
      );
    const entries = async () =>
      packs().listLedgerEntries({ customer_id: CUSTOMER_ID }, { take: 200 });
    const balance = async () =>
      (await ledger()).reduce((sum, r) => sum + Number(r.amount), 0);

    describe('TGPay deposit callback', () => {
      const post = (body: unknown, headers: Record<string, string> = AUTH) =>
        unwrapResponse(api.post('/hooks/tgpay/deposit', body, { headers }));

      const seedDeposit = async (merchantRefNum: string) => {
        const [row] = await packs().createGlobePayDeposits([
          {
            merchant_transaction_id: merchantRefNum,
            customer_id: CUSTOMER_ID,
            amount_requested: 50,
            payment_method_code: 'BQR',
            status: 'pending',
            gateway: 'tgpay',
          },
        ]);
        return row;
      };

      const approved = (merchantRefNum: string, over = {}) => ({
        status: 1,
        msg: 'ok',
        data: {
          amount: 50,
          transactionRefNum: `tx-${merchantRefNum}`,
          merchantRefNum,
          paymentMethod: 'EWALLET',
          bankName: 'TNG',
          status: 'APPROVED',
          ...over,
        },
      });

      it('is reachable with NO customer token and NO publishable key, and refuses bad keys', async () => {
        const res = await post(approved('PC-int-nokeys'), {});
        expect(res.status).toBe(401);
        expect(res.data).toBe('rejected');
      });

      it('credits the ledger on APPROVED, marks the row settled, and only once on retry', async () => {
        const mtid = 'PC-int-tgpay-settle';
        const row = await seedDeposit(mtid);

        const body = approved(mtid);
        expect((await post(body)).data).toBe('success');
        expect((await post(body)).data).toBe('success');

        const rows = (await ledger()).filter(
          (r) => r.reference === `tx-${mtid}`,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ reason: 'topup', pull_id: null });
        expect(Number(rows[0].amount)).toBe(50);

        const tp = (await entries()).filter(
          (e) => e.type === 'TP' && e.payload?.gateway_ref === `tx-${mtid}`,
        );
        expect(tp).toHaveLength(1);
        expect(Number(tp[0].wallet_delta)).toBe(50);
        expect(tp[0].payload).toMatchObject({ payment_method: 'BQR' });

        const [after] = await packs().listGlobePayDeposits(
          { id: row.id },
          { take: 1 },
        );
        expect(after.status).toBe('settled');
        expect(after.gateway_transaction_id).toBe(`tx-${mtid}`);
        expect(Number(after.amount_settled)).toBe(50);
        expect(after.settled_at).toBeTruthy();
      });

      it('refuses a callback whose amount is not the row amount, leaving the row pending', async () => {
        const mtid = 'PC-int-tgpay-amount';
        const row = await seedDeposit(mtid);
        const res = await post(approved(mtid, { amount: 5000 }));
        expect(res.status).toBe(400);
        expect(res.data).toBe('rejected');
        const [after] = await packs().listGlobePayDeposits(
          { id: row.id },
          { take: 1 },
        );
        expect(after.status).toBe('pending');
        expect(
          (await ledger()).filter((r) => r.reference === `tx-${mtid}`),
        ).toHaveLength(0);
      });
    });

    describe('TGPay payout callback', () => {
      const post = (body: unknown, headers: Record<string, string> = AUTH) =>
        unwrapResponse(api.post('/hooks/tgpay/withdrawal', body, { headers }));

      /** Fund the customer, debit, and seed the pending payout row exactly as
       *  startGlobePayWithdrawal does after an accepted submit. */
      const seedWithdrawal = async (merchantRefNum: string, amount = 50) => {
        await packs().mutateCreditAtomic({
          customerId: CUSTOMER_ID,
          amount,
          reason: 'topup',
          idempotencyReference: `wd-int-fund:${merchantRefNum}`,
        });
        const debit = await packs().mutateCreditAtomic({
          customerId: CUSTOMER_ID,
          amount: -amount,
          reason: 'cashout',
          reference: merchantRefNum,
          idempotencyReference: withdrawalIdempotencyReference(
            CUSTOMER_ID,
            merchantRefNum,
          ),
          floor: 0,
        });
        const [row] = await packs().createGlobePayWithdrawals([
          {
            merchant_transaction_id: merchantRefNum,
            gateway_transaction_id: `tx-${merchantRefNum}`,
            customer_id: CUSTOMER_ID,
            amount,
            bank_code: 'MBBEMYKL',
            account_number: '1234567890',
            account_holder_name: 'AHMAD BIN ALI',
            status: 'pending',
            gateway: 'tgpay',
          },
        ]);
        return { row, balanceAfterDebit: debit.balance };
      };

      const notify = (merchantRefNum: string, status: string, amount = 50) => ({
        transactionId: `tx-${merchantRefNum}`,
        status,
        amount,
        fee: 1,
        paymentAt: new Date().toISOString(),
        orderno: merchantRefNum,
        payType: 'BANK',
      });

      it('success settles the row and leaves the balance debited', async () => {
        const mtid = 'PC-int-tgpay-wd-ok';
        const { row, balanceAfterDebit } = await seedWithdrawal(mtid);
        const res = await post(notify(mtid, 'success'));
        expect(res.status).toBe(200);
        expect(res.data).toBe('success');
        const [after] = await packs().listGlobePayWithdrawals(
          { id: row.id },
          { take: 1 },
        );
        expect(after.status).toBe('settled');
        expect(Number(after.net_amount)).toBe(49);
        expect(after.settled_at).toBeTruthy();
        expect(await balance()).toBe(balanceAfterDebit);
      });

      it('reject refunds the debit against the real ledger, exactly once', async () => {
        const mtid = 'PC-int-tgpay-wd-reject';
        const { row, balanceAfterDebit } = await seedWithdrawal(mtid);
        expect((await post(notify(mtid, 'reject'))).data).toBe('success');
        expect((await post(notify(mtid, 'reject'))).data).toBe('success');

        const [after] = await packs().listGlobePayWithdrawals(
          { id: row.id },
          { take: 1 },
        );
        expect(after.status).toBe('failed');
        expect(await balance()).toBe(balanceAfterDebit + 50);
        const refunds = await packs().listCreditTransactions(
          {
            customer_id: CUSTOMER_ID,
            source_transaction_id: withdrawalRefundReference(CUSTOMER_ID, mtid),
          },
          { take: 5 },
        );
        expect(refunds).toHaveLength(1);
        expect(Number(refunds[0].amount)).toBe(50);
      });

      it('a success arriving after the reject does not flip the failed row or take the refund back', async () => {
        const mtid = 'PC-int-tgpay-wd-late';
        const { row, balanceAfterDebit } = await seedWithdrawal(mtid);
        await post(notify(mtid, 'reject'));
        expect((await post(notify(mtid, 'success'))).data).toBe('success');
        const [after] = await packs().listGlobePayWithdrawals(
          { id: row.id },
          { take: 1 },
        );
        expect(after.status).toBe('failed');
        expect(await balance()).toBe(balanceAfterDebit + 50);
      });
    });
  },
});
