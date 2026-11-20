import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { gmpaySign } from '../../src/modules/packs/gmpay-client';
import {
  withdrawalIdempotencyReference,
  withdrawalRefundReference,
} from '../../src/modules/packs/gateway-withdrawal';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// GMpay (PayFlowXZ v3, SGD) callbacks, end to end against a booted server and
// a real database. The unit specs (src/api/hooks/gmpay/__tests__) mock the
// packs service; this proves what they cannot: that a gateway='gmpay' row
// with its S$ lock round-trips through Postgres, that /hooks/gmpay/* hands the
// handler the RAW body its SHA-256 signature is checked against, and that a
// verified callback moves the real ledger exactly once.
//
// The test plays GMpay with a fake secret. Nothing here may reach the network:
// the sweeps that run inside the harness requery pending gmpay rows, so the
// GMpay host is stubbed (always "initiated", i.e. wait) and every other host
// passes through untouched.

const GMPAY_BASE = 'https://xapi.example.test/v3';
const SECRET = 'secret';
const LOOPBACK = '127.0.0.1';

process.env.GATEWAY_ENABLED = 'true';
process.env.GMPAY_ENABLED = 'true';
process.env.GMPAY_API_BASE = GMPAY_BASE;
process.env.GMPAY_CLIENT_ID = 'client-1';
process.env.GMPAY_SECRET_KEY = SECRET;
process.env.GMPAY_CURRENCY = 'SGD';
// The allowlist is IPv4 only and the test client may connect over ::1, so the
// requests below name their source the way App Platform's ingress does
// (do-connecting-ip, read first by callbackSourceIp).
process.env.GMPAY_CALLBACK_IPS = LOOPBACK;
process.env.PAYMENT_CALLBACK_BASE = 'https://backend.example.test';
// No real receipt email from a test run, whatever the local env holds.
delete process.env.RESEND_API_KEY;
delete process.env.RESEND_FROM_EMAIL;

// Each test file gets its own jest global, so this never leaks to other suites.
const realFetch = globalThis.fetch;
const gmpayRequests: string[] = [];
globalThis.fetch = async (
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (!url.startsWith(`${GMPAY_BASE}/`)) return realFetch(input, init);
  const path = url.slice(GMPAY_BASE.length + 1);
  gmpayRequests.push(path);
  const sent =
    typeof init?.body === 'string'
      ? (JSON.parse(init.body) as Record<string, unknown>)
      : {};
  const answer =
    path === 'payinQuery' || path === 'payoutQuery'
      ? {
          status_code: 0,
          status_msg: 'NO_ERROR',
          tran_token: sent.tran_token,
          tran_status: 'initiated',
        }
      : { status_code: -1, status_msg: 'NOT_AVAILABLE_IN_TEST' };
  return new Response(JSON.stringify(answer), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
};

type Fields = Record<string, string | number>;

/** A GMpay-shaped raw body, signed with `secret` (ours unless overridden). */
const signed = (fields: Fields, secret = SECRET): string =>
  JSON.stringify({ ...fields, tran_signature: gmpaySign(fields, secret) });

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    const packs = () =>
      getContainer().resolve<PacksModuleService>(PACKS_MODULE);

    /** A real customer with no email (so no receipt is ever sent). */
    const seedCustomer = async (name: string): Promise<string> => {
      const customer = await getContainer()
        .resolve(Modules.CUSTOMER)
        .createCustomers({ first_name: 'GMpay', last_name: name });
      return customer.id;
    };

    const credits = (customerId: string) =>
      packs().listCreditTransactions(
        { customer_id: customerId },
        { take: 200 },
      );
    const balance = async (customerId: string) =>
      (await credits(customerId)).reduce((sum, r) => sum + Number(r.amount), 0);

    // A string body goes on the wire byte for byte: the signature is over
    // exactly what is sent.
    const post = (
      path: 'deposit' | 'withdrawal',
      raw: string,
      sourceIp = LOOPBACK,
    ) =>
      unwrapResponse(
        api.post(`/hooks/gmpay/${path}`, raw, {
          headers: {
            'content-type': 'application/json',
            'do-connecting-ip': sourceIp,
          },
        }),
      );

    describe('GMpay pay-in callback', () => {
      // S$100 locked at mid 3.20, markup 0.01 -> credit RM 319.00 (as the
      // deposit route writes it: currency, gateway_amount, fx_mid, fx_markup).
      const seedDeposit = async (
        customerId: string,
        merchantTransactionId: string,
        token: string,
      ) => {
        const [row] = await packs().createGatewayDeposits([
          {
            merchant_transaction_id: merchantTransactionId,
            gateway_transaction_id: token,
            customer_id: customerId,
            amount_requested: 319,
            payment_method_code: 'BQR',
            status: 'pending',
            gateway: 'gmpay',
            currency: 'SGD',
            gateway_amount: 100,
            fx_mid: 3.2,
            fx_markup: 0.01,
          },
        ]);
        return row;
      };

      const payin = (
        customerId: string,
        merchantTransactionId: string,
        token: string,
        over: Fields = {},
      ): Fields => ({
        status_code: 0,
        status_msg: 'NO_ERROR',
        tran_token: token,
        tran_reference: `REF-${token}`,
        tran_customer: customerId,
        tran_amount: 100,
        tran_actual_amount: 100,
        tran_unique: merchantTransactionId,
        tran_fee: 1,
        tran_status: 'completed',
        tran_createtime: '2026-11-19 18:00:00',
        tran_lastupdated: '2026-11-19 18:01:00',
        ...over,
      });

      const rowOf = async (id: string) =>
        (await packs().listGatewayDeposits({ id }, { take: 1 }))[0];

      it('credits the locked RM once, settles the row, and answers OK (also on a retry)', async () => {
        const customerId = await seedCustomer('settle');
        const mtid = 'PC-int-gmpay-settle';
        const row = await seedDeposit(customerId, mtid, 'tok-1');
        const before = await balance(customerId);

        const raw = signed(payin(customerId, mtid, 'tok-1'));
        const first = await post('deposit', raw);
        expect(first.status).toBe(200);
        expect(first.data).toBe('OK');

        const after = await rowOf(row.id);
        expect(after.status).toBe('settled');
        expect(after.gateway).toBe('gmpay');
        expect(after.currency).toBe('SGD');
        expect(Number(after.gateway_amount)).toBe(100);
        expect(after.gateway_transaction_id).toBe('tok-1');
        expect(Number(after.amount_settled)).toBe(319);
        // Net of their S$1 fee at the same lock: S$99 -> RM 315.81.
        expect(Number(after.net_amount)).toBe(315.81);
        expect(after.settled_at).toBeTruthy();

        expect(await balance(customerId)).toBe(before + 319);
        const topups = (await credits(customerId)).filter(
          (r) => r.reference === 'tok-1',
        );
        expect(topups).toHaveLength(1);
        expect(topups[0]).toMatchObject({ reason: 'topup', pull_id: null });
        expect(Number(topups[0].amount)).toBe(319);
        const tp = (
          await packs().listLedgerEntries(
            { customer_id: customerId },
            { take: 200 },
          )
        ).filter((e) => e.type === 'TP' && e.payload?.gateway_ref === 'tok-1');
        expect(tp).toHaveLength(1);
        expect(Number(tp[0].wallet_delta)).toBe(319);

        // Delivery is at least once: the identical callback again moves nothing.
        const again = await post('deposit', raw);
        expect(again.status).toBe(200);
        expect(again.data).toBe('OK');
        expect(await balance(customerId)).toBe(before + 319);
        expect(
          (await credits(customerId)).filter((r) => r.reference === 'tok-1'),
        ).toHaveLength(1);
      });

      it('refuses a callback carrying another token than the row holds — no credit', async () => {
        const customerId = await seedCustomer('token');
        const mtid = 'PC-int-gmpay-token';
        // Its own stored token, so this row never shares a ledger reference
        // with the settle case above (a shared one could mask a pass-through
        // as a "hand-credited" refusal).
        const row = await seedDeposit(customerId, mtid, 'tok-2');
        const before = await balance(customerId);

        const res = await post(
          'deposit',
          signed(payin(customerId, mtid, 'tok-X')),
        );
        expect(res.status).toBe(400);
        expect(res.data).toBe('rejected');

        const after = await rowOf(row.id);
        expect(after.status).toBe('pending');
        expect(after.gateway_transaction_id).toBe('tok-2');
        expect(after.amount_settled).toBeNull();
        expect(await balance(customerId)).toBe(before);
      });

      it('refuses an amount above the lock (S$100.01 against S$100) — no credit', async () => {
        const customerId = await seedCustomer('over');
        const mtid = 'PC-int-gmpay-over';
        const row = await seedDeposit(customerId, mtid, 'tok-3');
        const before = await balance(customerId);

        const res = await post(
          'deposit',
          signed(
            payin(customerId, mtid, 'tok-3', { tran_actual_amount: 100.01 }),
          ),
        );
        expect(res.status).toBe(400);
        expect(res.data).toBe('rejected');

        const after = await rowOf(row.id);
        expect(after.status).toBe('pending');
        expect(after.amount_settled).toBeNull();
        expect(await balance(customerId)).toBe(before);
      });

      it('refuses unsigned, foreign-signed and tampered callbacks, and an unlisted source — no credit', async () => {
        const customerId = await seedCustomer('unsigned');
        const mtid = 'PC-int-gmpay-unsigned';
        const row = await seedDeposit(customerId, mtid, 'tok-5');
        const before = await balance(customerId);
        const fields = payin(customerId, mtid, 'tok-5');

        const unsigned = await post('deposit', JSON.stringify(fields));
        expect(unsigned.status).toBe(400);
        expect(unsigned.data).toBe('rejected');

        const foreign = await post('deposit', signed(fields, 'someone-else'));
        expect(foreign.status).toBe(400);

        // Signed over S$100, then the amount edited on the wire.
        const tampered = await post(
          'deposit',
          signed(fields).replace(
            '"tran_actual_amount":100',
            '"tran_actual_amount":1000',
          ),
        );
        expect(tampered.status).toBe(400);

        // A perfectly signed body from an address not on GMPAY_CALLBACK_IPS
        // never reaches the handler.
        const unlisted = await post('deposit', signed(fields), '203.0.113.7');
        expect(unlisted.status).toBe(403);
        expect(unlisted.data).toBe('rejected');

        const after = await rowOf(row.id);
        expect(after.status).toBe('pending');
        expect(await balance(customerId)).toBe(before);

        // The withdrawal hook holds the same gate.
        const payoutUnsigned = await post(
          'withdrawal',
          JSON.stringify({
            tran_unique: 'PW-int-gmpay-none',
            tran_token: 'tok-none',
            tran_status: 'rejected',
            status_code: 0,
          }),
        );
        expect(payoutUnsigned.status).toBe(400);
        expect(payoutUnsigned.data).toBe('rejected');
      });
    });

    describe('GMpay payout callback', () => {
      // RM debited at payout rate 3.20 (mid 3.18 + markup 0.02): RM 3.20 per S$.
      const seedWithdrawal = async (
        customerId: string,
        merchantTransactionId: string,
        token: string,
        amount: number,
        gatewayAmount: number,
      ) => {
        // Fund, debit and seed the pending row exactly as startWithdrawal
        // leaves it after an accepted submit (tgpay-callback.spec.ts).
        await packs().mutateCreditAtomic({
          customerId,
          amount,
          reason: 'topup',
          idempotencyReference: `wd-int-fund:${merchantTransactionId}`,
        });
        const debit = await packs().mutateCreditAtomic({
          customerId,
          amount: -amount,
          reason: 'cashout',
          reference: merchantTransactionId,
          idempotencyReference: withdrawalIdempotencyReference(
            customerId,
            merchantTransactionId,
          ),
          floor: 0,
        });
        const [row] = await packs().createGatewayWithdrawals([
          {
            merchant_transaction_id: merchantTransactionId,
            gateway_transaction_id: token,
            customer_id: customerId,
            amount,
            bank_code: 'DBSSSGSG',
            account_number: '1234567890',
            account_holder_name: 'TAN AH KOW',
            status: 'pending',
            gateway: 'gmpay',
            currency: 'SGD',
            gateway_amount: gatewayAmount,
            fx_mid: 3.18,
            fx_markup: 0.02,
          },
        ]);
        return { row, balanceAfterDebit: debit.balance };
      };

      const payout = (
        customerId: string,
        merchantTransactionId: string,
        token: string,
        gatewayAmount: number,
        over: Fields = {},
      ): Fields => ({
        status_code: 0,
        status_msg: 'NO_ERROR',
        tran_token: token,
        tran_customer: customerId,
        bank_code: 'DBS',
        bank_account_name: 'TAN AH KOW',
        bank_account_number: '1234567890',
        tran_amount: gatewayAmount,
        tran_actual_amount: gatewayAmount,
        tran_unique: merchantTransactionId,
        tran_fee: 1,
        tran_status: 'completed',
        tran_createtime: '2026-11-19 18:00:00',
        tran_lastupdated: '2026-11-19 18:05:00',
        ...over,
      });

      const rowOf = async (id: string) =>
        (await packs().listGatewayWithdrawals({ id }, { take: 1 }))[0];

      const refundsOf = (customerId: string, merchantTransactionId: string) =>
        packs().listCreditTransactions(
          {
            customer_id: customerId,
            source_transaction_id: withdrawalRefundReference(
              customerId,
              merchantTransactionId,
            ),
          },
          { take: 5 },
        );

      it('rejected refunds the RM debit once (also on a retry) and redacts the reason', async () => {
        const customerId = await seedCustomer('wd-reject');
        const mtid = 'PW-int-gmpay-reject';
        const { row, balanceAfterDebit } = await seedWithdrawal(
          customerId,
          mtid,
          'tok-w1',
          160,
          50,
        );

        const raw = signed(
          payout(customerId, mtid, 'tok-w1', 50, {
            tran_status: 'rejected',
            tran_reject_reason: 'acct 1234567890 name Tan Ah Kow mismatch',
          }),
        );
        const first = await post('withdrawal', raw);
        expect(first.status).toBe(200);
        expect(first.data).toBe('OK');
        const again = await post('withdrawal', raw);
        expect(again.status).toBe(200);
        expect(again.data).toBe('OK');

        const after = await rowOf(row.id);
        expect(after.status).toBe('failed');
        expect(after.failure_reason).toBe(
          'callback rejected: acct [redacted] name [redacted] mismatch',
        );
        expect(await balance(customerId)).toBe(balanceAfterDebit + 160);
        const refunds = await refundsOf(customerId, mtid);
        expect(refunds).toHaveLength(1);
        // The RM debited, never the S$ figure.
        expect(Number(refunds[0].amount)).toBe(160);
      });

      it('completed settles the row in RM at the lock, no refund', async () => {
        const customerId = await seedCustomer('wd-ok');
        const mtid = 'PW-int-gmpay-ok';
        const { row, balanceAfterDebit } = await seedWithdrawal(
          customerId,
          mtid,
          'tok-w2',
          320,
          100,
        );

        const res = await post(
          'withdrawal',
          signed(payout(customerId, mtid, 'tok-w2', 100)),
        );
        expect(res.status).toBe(200);
        expect(res.data).toBe('OK');

        const after = await rowOf(row.id);
        expect(after.status).toBe('settled');
        expect(after.gateway_transaction_id).toBe('tok-w2');
        expect(Number(after.amount_settled)).toBe(320);
        // What our wallet PAID: S$100 + S$1 fee at RM 3.20 = RM 323.20.
        expect(Number(after.net_amount)).toBe(323.2);
        expect(after.settled_at).toBeTruthy();
        expect(await balance(customerId)).toBe(balanceAfterDebit);
        expect(await refundsOf(customerId, mtid)).toHaveLength(0);
      });
    });

    afterAll(() => {
      // Which GMpay calls the in-harness sweeps made (all stubbed), for the
      // record: a run that straddles a sweep shows them here.
      if (gmpayRequests.length > 0) {
        process.stdout.write(
          `[gmpay-callbacks.spec] stubbed GMpay calls: ${gmpayRequests.join(', ')}\n`,
        );
      }
    });
  },
});
