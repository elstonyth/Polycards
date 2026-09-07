/**
 * submitHeldWithdrawal / denyHeldWithdrawal against a REAL Postgres —
 * integration:modules
 *
 * The two admin exits from 'held' (plan 094). They used to be 372 + 136 lines
 * of route, driven by a stateful seven-method fake and three `jest.mock`s
 * (api/admin/payments/withdrawals/__tests__/approve-deny.unit.spec.ts, deleted
 * with this file's arrival). That harness could model the claim's ANSWER but
 * never the thing the answer is for: the claim, the debit read, the refund and
 * the terminal row update are one money ordering over one database, and a fake
 * `packs` returns whatever the test says to every step of it.
 *
 * So: the real service against real Postgres, and the real gateway seam with
 * only the HTTP replaced — the row names the `fake` gateway, so
 * rowGateway -> gatewayConfigFor -> adapterFor dispatches to fake-gateway.ts
 * exactly as production dispatches to TGPay. Nothing here is mocked; the
 * customer and notification modules are the only fakes, and only because a
 * modules-type container has neither.
 *
 * What this spec does NOT own: the advisory-lock interleaving itself
 * (withdrawal-claim.integration.spec.ts drives two connections for that) and
 * the routes' request-to-argument wiring
 * (api/admin/payments/withdrawals/__tests__/approve-deny-wiring.unit.spec.ts).
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules, MedusaError } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import GatewayWithdrawal from '../models/gateway-withdrawal';
import CreditTransaction from '../models/credit-transaction';
import CustomerAccountState from '../models/customer-account-state';
import LedgerEntry from '../models/ledger-entry';
import LedgerSequence from '../models/ledger-sequence';
import {
  denyHeldWithdrawal,
  submitHeldWithdrawal,
  withdrawalIdempotencyReference,
  withdrawalRefundReference,
} from '../gateway-withdrawal';
import { GatewayError, setActiveGateway } from '../gateway';
import { fakeGateway } from '../fake-gateway';

jest.setTimeout(300 * 1000);

const ACCOUNT_NUMBER = '1234567890';
const ADMIN = 'usr_admin_1';
const PAYER_IP = '10.0.0.7';

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  // CreditTransaction is the debit `claimWithdrawalAgainstDebit` reads and the
  // refund `refundWithdrawal` writes; the two ledger tables are what
  // withdrawCreditsWithLedger appends to (omit one and the refund branch dies
  // on `relation … does not exist`); CustomerAccountState is the freeze read.
  // A modules-type spec builds its schema from THIS array, never from the
  // migrations.
  moduleModels: [
    GatewayWithdrawal,
    CreditTransaction,
    CustomerAccountState,
    LedgerEntry,
    LedgerSequence,
  ],
  testSuite: ({ service, MikroOrmWrapper }) => {
    let sent: { channel: string; key: string }[] = [];
    let logged: string[] = [];
    /**
     * Every service method the operations call THROUGH THE CONTAINER, in
     * order. A proxy rather than `jest.spyOn`: MedusaService's generated
     * methods are not plain own properties, so spyOn cannot restore them —
     * and this records only calls that crossed the seam, which is exactly
     * what the lock guard below asks about (a method the service calls on
     * itself keeps `this` = the real service and never reaches the proxy).
     */
    let called: string[] = [];
    let withdrawalUpdates: unknown[][] = [];

    const logger = {
      info: (m: string) => logged.push(m),
      warn: (m: string) => logged.push(m),
      error: (m: string) => logged.push(m),
    };

    const recorded = new Proxy(service, {
      get(target, prop) {
        const value = target[prop as keyof PacksModuleService];
        if (typeof value !== 'function' || typeof prop !== 'string') {
          return value;
        }
        return (...args: unknown[]) => {
          called.push(prop);
          if (prop === 'updateGatewayWithdrawals') {
            withdrawalUpdates.push(args);
          }
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });

    const resolveFake = (key: string): unknown => {
      if (key === Modules.CUSTOMER) {
        return {
          retrieveCustomer: async () => ({
            email: 'payee@example.test',
            first_name: 'Ahmad',
            last_name: 'Ali',
            phone: '0123456789',
          }),
        };
      }
      if (key === Modules.NOTIFICATION) {
        return {
          createNotifications: async (n: {
            channel: string;
            idempotency_key: string;
          }) => {
            sent.push({ channel: n.channel, key: n.idempotency_key });
          },
        };
      }
      if (key === 'logger') return logger;
      return recorded;
    };
    const scope = {
      resolve: resolveFake as unknown as <T>(key: string) => T,
    };

    const ORIGINAL = { ...process.env };

    beforeEach(() => {
      sent = [];
      logged = [];
      called = [];
      withdrawalUpdates = [];
      fakeGateway.reset();
      // The active gateway is CACHED, so resolveActiveGateway short-circuits
      // on its TTL branch and never needs a site_settings table here.
      setActiveGateway('fake');
      process.env.PAYMENT_GATEWAY = 'fake';
      process.env.GATEWAY_ENABLED = 'true';
      process.env.GATEWAY_WITHDRAWALS_ENABLED = 'true';
      // https only — gatewayUrls treats anything else as unset and the
      // approve path then fails closed.
      process.env.PAYMENT_CALLBACK_BASE = 'https://us.test';
    });

    afterAll(() => {
      process.env = ORIGINAL;
      setActiveGateway(null);
    });

    let n = 0;
    /** A held row: written, never submitted, no gateway id. */
    const seed = async (over: Record<string, unknown> = {}) => {
      const suffix = `${++n}`;
      const [row] = await service.createGatewayWithdrawals([
        {
          merchant_transaction_id: `PW-HELD-${suffix}`,
          customer_id: `cus_held_${suffix}`,
          amount: 1500,
          bank_code: 'MBBEMYKL',
          account_number: ACCOUNT_NUMBER,
          account_holder_name: 'AHMAD BIN ALI',
          gateway: 'fake',
          status: 'held',
          ...over,
        },
      ]);
      return row;
    };

    /**
     * The debit startWithdrawal's step 2 would have written, on the real
     * `wd:` anchor — without it `claimWithdrawalAgainstDebit` answers
     * `debited: false` and every test below takes the orphan-close branch
     * instead of the one it means to exercise. Raw, on the wrapper's manager,
     * because withdrawForCashout needs a customer table this container has
     * not got.
     */
    const debit = async (row: {
      id: string;
      customer_id: string;
      merchant_transaction_id: string;
    }) => {
      const rows = await MikroOrmWrapper.getManager().execute<{ id: string }[]>(
        'INSERT INTO credit_transaction ' +
          '(id, customer_id, amount, raw_amount, reason, reference, source_transaction_id) ' +
          "VALUES (?, ?, ?, ?::jsonb, 'cashout', ?, ?) RETURNING id",
        [
          `ct_debit_${row.id}`,
          row.customer_id,
          -1500,
          JSON.stringify({ value: '-1500', precision: 20 }),
          row.merchant_transaction_id,
          withdrawalIdempotencyReference(
            row.customer_id,
            row.merchant_transaction_id,
          ),
        ],
      );
      // Asserted for the same reason withdrawal-claim.integration.spec.ts
      // asserts its backdate: a silent zero-row write would leave every
      // "refunded" assertion below passing against a row that was never
      // debited at all.
      expect(rows).toHaveLength(1);
    };

    const reread = async (id: string) =>
      (await service.listGatewayWithdrawals({ id }, { take: 1 }))[0];

    const creditRows = async (customerId: string) =>
      service.listCreditTransactions({ customer_id: customerId }, { take: 10 });

    describe('submitHeldWithdrawal', () => {
      it('submits the row’s OWN stored destination, stamps the gateway id and moves no money', async () => {
        const row = await seed();
        await debit(row);
        fakeGateway.script({
          submitWithdrawal: { transactionId: 'W2026081200000001' },
        });

        const result = await submitHeldWithdrawal(scope, {
          withdrawalId: row.id,
          adminId: ADMIN,
          payerIp: PAYER_IP,
        });

        expect(result).toEqual({
          id: row.id,
          status: 'pending',
          transaction_id: 'W2026081200000001',
          approved: true,
        });

        expect(fakeGateway.calls.withdrawals).toHaveLength(1);
        expect(fakeGateway.calls.withdrawals[0]).toMatchObject({
          merchantTransactionId: row.merchant_transaction_id,
          merchantClientId: row.customer_id,
          // bigNumber columns arrive as strings; submitWithdrawal calls
          // .toFixed(2) on this, which throws on the raw value.
          amount: 1500,
          destinationBankCode: 'MBBEMYKL',
          destinationAccountNumber: ACCOUNT_NUMBER,
          destinationAccountHolderName: 'AHMAD BIN ALI',
          // The ADMIN's address — the customer's was never stored.
          ipAddress: PAYER_IP,
          email: 'payee@example.test',
        });

        const after = await reread(row.id);
        expect(after.status).toBe('pending');
        expect(after.gateway_transaction_id).toBe('W2026081200000001');
        // An approve pays out a debit that already happened. It must not add,
        // return or otherwise touch a single credit row.
        expect(await creditRows(row.customer_id)).toHaveLength(1);
        expect(sent).toEqual([]);
      });

      // THE money test. A double-clicked Approve is the realistic trigger and
      // the failure mode is a duplicate payout to a real bank account. The
      // interleaved two-connection version lives in
      // withdrawal-claim.integration.spec.ts; what this pins is that the
      // second call reaches the gateway zero times.
      it('a double approve submits exactly ONCE — the second loses the claim', async () => {
        const row = await seed();
        await debit(row);

        const first = await submitHeldWithdrawal(scope, {
          withdrawalId: row.id,
          adminId: ADMIN,
          payerIp: PAYER_IP,
        });
        const second = await submitHeldWithdrawal(scope, {
          withdrawalId: row.id,
          adminId: ADMIN,
          payerIp: PAYER_IP,
        });

        expect(fakeGateway.calls.withdrawals).toHaveLength(1);
        expect(first.approved).toBe(true);
        // Idempotent, not an error: the operator's intent already happened,
        // and a second payout is the one outcome that cannot be undone. The
        // status reported is the row's as the loser READ it, pre-claim.
        expect(second).toEqual({
          id: row.id,
          status: 'pending',
          transaction_id: first.transaction_id,
          approved: false,
        });
      });

      // The genuinely concurrent twin of the test above. `Promise.all` fires
      // both calls in the same tick rather than awaiting them in turn — this
      // is not decorative: `submitHeldWithdrawal` never takes a JS-level
      // lock, and `@InjectTransactionManager` (service.ts) opens a FRESH
      // transaction per call whenever the caller passes no
      // `transactionManager` of its own, which neither call here does. Two
      // calls sharing the same `scope`/service therefore still run on two
      // independent transactions. The race is decided by the `credit:`
      // advisory lock inside claimWithdrawalAgainstDebit, not by test
      // ordering. Unlike the sequential test above, which caller wins is not
      // knowable ahead of time (and the loser's pre-claim row read may or may
      // not have seen the winner's gateway id yet) — only the outcome is, so
      // this asserts the outcome and the re-read row rather than either
      // promise's `transaction_id`.
      it('a double approve raced CONCURRENTLY still submits exactly ONCE', async () => {
        const row = await seed();
        await debit(row);

        const [a, b] = await Promise.all([
          submitHeldWithdrawal(scope, {
            withdrawalId: row.id,
            adminId: ADMIN,
            payerIp: PAYER_IP,
          }),
          submitHeldWithdrawal(scope, {
            withdrawalId: row.id,
            adminId: ADMIN,
            payerIp: PAYER_IP,
          }),
        ]);

        expect(fakeGateway.calls.withdrawals).toHaveLength(1);

        const approved = [a, b].filter((r) => r.approved);
        const refused = [a, b].filter((r) => !r.approved);
        expect(approved).toHaveLength(1);
        expect(refused).toHaveLength(1);

        const after = await reread(row.id);
        expect(after.status).toBe('pending');
        // Exactly one gateway id landed on the row, and it is the winner's.
        expect(after.gateway_transaction_id).not.toBeNull();
        expect(after.gateway_transaction_id).toBe(approved[0].transaction_id);

        // No refund, no phantom credit: the original debit and nothing else.
        expect(await creditRows(row.customer_id)).toHaveLength(1);
      });

      it('a DEFINITE refusal refunds on the shared anchor and closes the row failed', async () => {
        const row = await seed();
        await debit(row);
        fakeGateway.script({
          submitWithdrawal: new GatewayError(
            'Insufficient payout float',
            ['PMT10013'],
            400,
            true,
          ),
        });

        await expect(
          submitHeldWithdrawal(scope, {
            withdrawalId: row.id,
            adminId: ADMIN,
            payerIp: PAYER_IP,
          }),
        ).rejects.toMatchObject({ type: MedusaError.Types.INVALID_DATA });

        const after = await reread(row.id);
        expect(after.status).toBe('failed');
        // Plan 095: the gateway's own codes survive the deploy's log
        // rotation, which is the only thing that can tell an empty merchant
        // float (PMT10013) apart from genuinely bad bank details later.
        expect(after.failure_reason).toContain('PMT10013');
        expect(after.failure_reason).toContain('approve refused');

        // The refund landed on the wd-refund: anchor, and the balance is
        // whole again (−1500 debit + 1500 refund).
        const credits = await creditRows(row.customer_id);
        expect(credits).toHaveLength(2);
        expect(credits.map((c) => c.source_transaction_id).sort()).toEqual(
          [
            withdrawalIdempotencyReference(
              row.customer_id,
              row.merchant_transaction_id,
            ),
            withdrawalRefundReference(
              row.customer_id,
              row.merchant_transaction_id,
            ),
          ].sort(),
        );
        expect(await service.creditBalance(row.customer_id)).toBe(0);

        // The customer is told once, on both channels.
        expect(sent.map((s) => s.channel)).toEqual(['email', 'customer_feed']);

        // All seven fields of the refusal line, so none can be dropped.
        const lines = logged.join('\n');
        expect(lines).toContain('PMT10013');
        expect(lines).toContain('httpStatus=400');
        expect(lines).toContain('definite=true');
        expect(lines).toContain('bankCode=MBB');
        expect(lines).toContain('amount=1500');
        expect(lines).toContain(row.merchant_transaction_id);
        expect(lines).toContain('Insufficient payout float');
      });

      it('an AMBIGUOUS submit error leaves the row claimed for the sweep — never a refund', async () => {
        const row = await seed();
        await debit(row);
        fakeGateway.script({ submitWithdrawal: new Error('socket hang up') });

        // Returns rather than throws: a 500 reads as "nothing happened" and
        // invites a retry, while the payout may well be in flight.
        const result = await submitHeldWithdrawal(scope, {
          withdrawalId: row.id,
          adminId: ADMIN,
          payerIp: PAYER_IP,
        });
        expect(result).toEqual({
          id: row.id,
          status: 'pending',
          transaction_id: null,
          approved: true,
        });

        // Exactly the state the reconcile sweep resolves: pending, no gateway
        // id, no refund. Refunding here double-pays.
        const after = await reread(row.id);
        expect(after.status).toBe('pending');
        expect(after.gateway_transaction_id).toBeNull();
        expect(after.failure_reason).toBeNull();
        expect(await creditRows(row.customer_id)).toHaveLength(1);
        expect(sent).toEqual([]);
        expect(logged.join('\n')).toMatch(/ambiguous/i);
      });

      // A crash between startWithdrawal's step 1 and step 2 strands a held
      // row with NO debit. Submitting it pays a bank account against a balance
      // that was never reduced.
      it('refuses a held row that was never debited, closing it instead', async () => {
        const row = await seed();

        await expect(
          submitHeldWithdrawal(scope, {
            withdrawalId: row.id,
            adminId: ADMIN,
            payerIp: PAYER_IP,
          }),
        ).rejects.toMatchObject({ type: MedusaError.Types.INVALID_DATA });

        expect(fakeGateway.calls.withdrawals).toEqual([]);
        expect((await reread(row.id)).status).toBe('failed');
        // "Refunding" a row that never took the money would mint credit.
        expect(await creditRows(row.customer_id)).toHaveLength(0);
      });

      it('404s an unknown id without touching anything', async () => {
        await expect(
          submitHeldWithdrawal(scope, {
            withdrawalId: 'gpw_does_not_exist',
            adminId: ADMIN,
            payerIp: PAYER_IP,
          }),
        ).rejects.toMatchObject({ type: MedusaError.Types.NOT_FOUND });
        expect(fakeGateway.calls.withdrawals).toEqual([]);
      });

      // Every precondition runs BEFORE the claim: a claim to 'pending'
      // followed by a throw strands a row that was never submitted and hands
      // it to the sweep for no reason.
      it('refuses with the payout channel closed, leaving the row held', async () => {
        process.env.GATEWAY_WITHDRAWALS_ENABLED = 'false';
        const row = await seed();
        await debit(row);

        await expect(
          submitHeldWithdrawal(scope, {
            withdrawalId: row.id,
            adminId: ADMIN,
            payerIp: PAYER_IP,
          }),
        ).rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED });
        expect((await reread(row.id)).status).toBe('held');
        expect(fakeGateway.calls.withdrawals).toEqual([]);
      });

      it('refuses without a reachable NotifyUrl — a payout that could never refund', async () => {
        delete process.env.PAYMENT_CALLBACK_BASE;
        const row = await seed();
        await debit(row);

        await expect(
          submitHeldWithdrawal(scope, {
            withdrawalId: row.id,
            adminId: ADMIN,
            payerIp: PAYER_IP,
          }),
        ).rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED });
        expect((await reread(row.id)).status).toBe('held');
        expect(fakeGateway.calls.withdrawals).toEqual([]);
      });

      // The ONE piece of the request-time gate that must be re-read: a freeze
      // landing while the row sat held is exactly how "this payout is
      // suspicious" gets recorded, and the queue's `frozen` field is a poll-
      // time preview, not the gate. Cause-agnostic, like walletSummary.
      it('refuses a frozen customer before the claim, whatever the cause', async () => {
        const row = await seed();
        await debit(row);
        await service.createCustomerAccountStates([
          {
            customer_id: row.customer_id,
            frozen: true,
            // 'auto' (clawback debt), NOT 'manual': assertNotFrozen is
            // manual-scoped and would let this one through, which is why the
            // approve path reads the flag itself.
            cause: 'auto',
            frozen_reason: 'clawback debt',
          },
        ]);

        await expect(
          submitHeldWithdrawal(scope, {
            withdrawalId: row.id,
            adminId: ADMIN,
            payerIp: PAYER_IP,
          }),
        ).rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED });
        expect((await reread(row.id)).status).toBe('held');
        expect(fakeGateway.calls.withdrawals).toEqual([]);
      });

      it('logs the actor and the row, and NEVER the account number', async () => {
        const row = await seed();
        await debit(row);
        await submitHeldWithdrawal(scope, {
          withdrawalId: row.id,
          adminId: ADMIN,
          payerIp: PAYER_IP,
        });
        const lines = logged.join('\n');
        expect(lines).toContain(ADMIN);
        expect(lines).toContain(row.id);
        // Boolean, not .not.toContain(): a failing toContain prints the
        // logged string — the account number — into a public CI log.
        expect(lines.includes(ACCOUNT_NUMBER)).toBe(false);
      });
    });

    describe('denyHeldWithdrawal', () => {
      it('claims the row failed BEFORE refunding, and audits the admin', async () => {
        const row = await seed();
        await debit(row);

        const result = await denyHeldWithdrawal(scope, {
          withdrawalId: row.id,
          adminId: ADMIN,
        });
        expect(result).toEqual({
          id: row.id,
          status: 'failed',
          refunded: true,
        });

        const after = await reread(row.id);
        expect(after.status).toBe('failed');
        // Plan 095: names the admin, so a denied row is never later mistaken
        // for one the gateway refused.
        expect(after.failure_reason).toBe(`denied by admin ${ADMIN}`);
        expect(after.gateway_status).toBeNull();

        expect(await service.creditBalance(row.customer_id)).toBe(0);
        expect(await creditRows(row.customer_id)).toHaveLength(2);
        expect(sent.map((s) => s.channel)).toEqual(['email', 'customer_feed']);

        const lines = logged.join('\n');
        expect(lines).toContain(ADMIN);
        expect(lines).toContain(row.id);
        expect(lines).toContain('DENIED');
        expect(lines.includes(ACCOUNT_NUMBER)).toBe(false);
      });

      // The recovery path claim-first ordering exists to make safe: a crash
      // between the claim and the refund leaves a 'failed' row whose debit
      // never came back, and the sweep (pending-only) never revisits it. An
      // operator clicking Deny again must settle it — and a second click on a
      // settled one must credit exactly once, on the shared anchor.
      it('is re-runnable on its OWN failed row and credits exactly once', async () => {
        const row = await seed();
        await debit(row);

        await denyHeldWithdrawal(scope, {
          withdrawalId: row.id,
          adminId: ADMIN,
        });
        const again = await denyHeldWithdrawal(scope, {
          withdrawalId: row.id,
          adminId: ADMIN,
        });

        expect(again).toEqual({ id: row.id, status: 'failed', refunded: true });
        expect(await creditRows(row.customer_id)).toHaveLength(2);
        expect(await service.creditBalance(row.customer_id)).toBe(0);
        // The !replayed guard: the customer is told once about the feed row.
        expect(sent.filter((s) => s.channel === 'customer_feed')).toHaveLength(
          1,
        );
      });

      // Deny accepts 'failed' so that recovery works, which also lets an
      // operator click it on a row the bank already refused. Harmless to the
      // money (one anchor) but it must not overwrite the bank's diagnostic.
      it("a mistaken Deny keeps the gateway's failure_reason and gateway_status", async () => {
        const row = await seed({
          status: 'failed',
          gateway_status: 5,
          failure_reason: 'sweep: requery statusId 5',
        });
        await debit(row);

        await denyHeldWithdrawal(scope, {
          withdrawalId: row.id,
          adminId: ADMIN,
        });

        const after = await reread(row.id);
        expect(after.failure_reason).toBe('sweep: requery statusId 5');
        expect(after.gateway_status).toBe(5);
      });

      it('refuses a settled row and a pending one — neither is deny’s to touch', async () => {
        const settled = await seed({ status: 'settled' });
        await debit(settled);
        await expect(
          denyHeldWithdrawal(scope, {
            withdrawalId: settled.id,
            adminId: ADMIN,
          }),
        ).rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED });
        expect((await reread(settled.id)).status).toBe('settled');
        expect(await creditRows(settled.customer_id)).toHaveLength(1);

        // 'pending' belongs to the gateway and the sweep.
        const pending = await seed({ status: 'pending' });
        await debit(pending);
        await expect(
          denyHeldWithdrawal(scope, {
            withdrawalId: pending.id,
            adminId: ADMIN,
          }),
        ).rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED });
        expect((await reread(pending.id)).status).toBe('pending');
      });

      it('closes a never-debited row WITHOUT refunding it', async () => {
        const row = await seed();

        const result = await denyHeldWithdrawal(scope, {
          withdrawalId: row.id,
          adminId: ADMIN,
        });
        expect(result).toEqual({
          id: row.id,
          status: 'failed',
          refunded: false,
        });
        expect((await reread(row.id)).status).toBe('failed');
        // Refunding a row that never took the customer's money mints credit.
        expect(await creditRows(row.customer_id)).toHaveLength(0);
        expect(sent).toEqual([]);
        expect(logged.join('\n')).toMatch(/no debit/i);
      });

      it('404s an unknown id', async () => {
        await expect(
          denyHeldWithdrawal(scope, {
            withdrawalId: 'gpw_does_not_exist',
            adminId: ADMIN,
          }),
        ).rejects.toMatchObject({ type: MedusaError.Types.NOT_FOUND });
      });

      // Asymmetric with approve on purpose: handing money back must not
      // depend on the payout channel being open — that is exactly when a
      // queue of held rows most needs clearing.
      it('still works with the payout channel switched off', async () => {
        process.env.GATEWAY_WITHDRAWALS_ENABLED = 'false';
        const row = await seed();
        await debit(row);
        await expect(
          denyHeldWithdrawal(scope, { withdrawalId: row.id, adminId: ADMIN }),
        ).resolves.toMatchObject({ refunded: true });
      });
    });

    /**
     * THE REGRESSION GUARD for the finding that produced
     * claimWithdrawalAgainstDebit.
     *
     * Both operations used to read the debit with an unlocked
     * listCreditTransactions and then flip the row with a bare
     * claimWithdrawalStatus. Between those two calls a debit queued on the
     * customer's `credit:` lock could commit, so an admin could close a row
     * that was about to be debited and strand the money — the sweep selects
     * 'pending' only and never revisits a 'failed' row.
     *
     * Reintroducing either unlocked call reopens the window while every other
     * test here stays green, so it is asserted directly. The real method runs
     * underneath; only the forbidden two are watched.
     *
     * The proxy also records generated-update arguments: a redundant
     * same-status write would escape final-row assertions. Successful approve
     * must update only the provider reference after the locked claim; refund
     * paths legitimately write a terminal status through the generated method.
     */
    describe('the debit decision never happens outside the lock', () => {
      it.each([
        [
          'submitHeldWithdrawal',
          (id: string) =>
            submitHeldWithdrawal(scope, {
              withdrawalId: id,
              adminId: ADMIN,
              payerIp: PAYER_IP,
            }),
        ],
        [
          'denyHeldWithdrawal',
          (id: string) =>
            denyHeldWithdrawal(scope, { withdrawalId: id, adminId: ADMIN }),
        ],
      ])(
        '%s reads and claims only through the locked method',
        async (_name, run) => {
          const row = await seed();
          await debit(row);
          // The seed helpers go through `service` directly, so `called`
          // holds the operation's own calls alone.
          called = [];
          withdrawalUpdates = [];

          await run(row.id);

          // Exactly once, not merely "at least once": a caller that claimed
          // twice (e.g. a retry loop swallowing the first lost claim) would
          // still pass a bare `toContain`.
          expect(
            called.filter((c) => c === 'claimWithdrawalAgainstDebit'),
          ).toHaveLength(1);
          expect(called).not.toContain('listCreditTransactions');
          expect(called).not.toContain('claimWithdrawalStatus');
          if (_name === 'submitHeldWithdrawal') {
            expect(withdrawalUpdates).toHaveLength(1);
            const [update] = withdrawalUpdates[0] as [{ data: unknown }];
            expect(update.data).not.toHaveProperty('status');
          }
        },
      );
    });
  },
});
