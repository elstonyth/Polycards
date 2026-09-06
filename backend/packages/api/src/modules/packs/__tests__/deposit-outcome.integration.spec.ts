/**
 * applyDepositOutcome against a REAL Postgres — integration:modules
 *
 * WHY a DB-backed spec and not another mocked one: this function is the one
 * place a settled deposit becomes money. Three of the four things it does are
 * only true if the database says so — the credit lands exactly once on its
 * idempotency anchor, the row's status flip is a CONDITIONAL claim that a
 * replay must LOSE, and the settlement mirror columns (a bigNumber pair with
 * paired raw_* jsonb) actually persist. A fake `em` answers whatever the test
 * says to all three, so it could not tell us any of them.
 *
 * The receipt/feed side stays faked here (they are the notification module,
 * not this module's schema); what is asserted about them is COUNT and
 * ORDER, which is where the idempotency lives.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import GatewayDeposit from '../models/gateway-deposit';
import CreditTransaction from '../models/credit-transaction';
import LedgerEntry from '../models/ledger-entry';
import LedgerSequence from '../models/ledger-sequence';
import CustomerAccountState from '../models/customer-account-state';
import { applyDepositOutcome } from '../gateway-deposit';
import { topupIdempotencyReference } from '../topup';

jest.setTimeout(300 * 1000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  // CreditTransaction + the two ledger tables are what topUpCreditsWithLedger
  // writes, and CustomerAccountState is what its auto-unfreeze probe reads. A
  // modules-type spec builds its schema from THIS array, never from the
  // migrations, so omitting one is an unfixable "relation does not exist".
  moduleModels: [
    GatewayDeposit,
    CreditTransaction,
    LedgerEntry,
    LedgerSequence,
    CustomerAccountState,
  ],
  testSuite: ({ service }) => {
    /** Every notification the run handed to the notification module, in
     *  order — the receipt and the feed row share it, so one array proves
     *  both the count and the sequence. */
    let sent: { channel: string; key: string }[] = [];

    // The container the two call sites hand in. Its `resolve` is generic on
    // the production side, so the fake is cast once here rather than at each
    // of the call sites below.
    const resolveFake = (key: string): unknown => {
      if (key === Modules.CUSTOMER) {
        return {
          retrieveCustomer: async () => ({ email: 'buyer@example.test' }),
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
      if (key === 'logger') {
        return { info: () => {}, warn: () => {}, error: () => {} };
      }
      return service;
    };
    const scope = {
      resolve: resolveFake as unknown as <T>(key: string) => T,
    };

    beforeEach(() => {
      sent = [];
    });

    const seed = async (
      suffix: string,
      status: 'pending' | 'settled' | 'failed' | 'expired' = 'pending',
      amountRequested = 50,
    ) => {
      const [row] = await service.createGatewayDeposits([
        {
          merchant_transaction_id: `PC-OUT-${suffix}`,
          customer_id: `cus_out_${suffix}`,
          amount_requested: amountRequested,
          payment_method_code: 'OB',
          gateway_transaction_id: `tx-${suffix}`,
          gateway: 'tgpay',
          status,
        },
      ]);
      return row;
    };

    const reread = async (id: string) =>
      (await service.listGatewayDeposits({ id }, { take: 1 }))[0];

    /** Defaults to the CALLBACK source — the fenced one. Pass
     *  `{ source: 'requery' }` for the sweep's semantics. */
    const settled = (over: Record<string, unknown> = {}) =>
      ({
        state: 'settled' as const,
        source: 'callback' as const,
        amount: 50,
        gatewayRef: 'tx-1',
        settledAt: new Date('2026-09-06T10:00:00.000Z'),
        ...over,
      }) as Parameters<typeof applyDepositOutcome>[2];

    describe('the settled outcome', () => {
      it('credits the ledger, settles the row and sends exactly one receipt and one feed row', async () => {
        const row = await seed('1');

        const result = await applyDepositOutcome(
          scope,
          row,
          settled({
            gatewayRef: 'tx-1',
            netAmount: 48.5,
            bankReferenceNo: 'BR-1',
            uniqueReferenceNo: 'UR-1',
            gatewayStatus: 4,
          }),
        );

        expect(result).toEqual({ applied: true, replayed: false });

        // The money.
        const credits = await service.listCreditTransactions(
          { customer_id: row.customer_id },
          { take: 10 },
        );
        expect(credits).toHaveLength(1);
        expect(Number(credits[0].amount)).toBe(50);
        expect(credits[0].source_transaction_id).toBe(
          topupIdempotencyReference(
            row.customer_id,
            row.merchant_transaction_id,
          ),
        );
        const entries = await service.listLedgerEntries(
          { customer_id: row.customer_id },
          { take: 10 },
        );
        expect(entries).toHaveLength(1);
        expect(entries[0].type).toBe('TP');

        // The row, including the bigNumber mirror pair.
        const after = await reread(row.id);
        expect(after.status).toBe('settled');
        expect(Number(after.amount_settled)).toBe(50);
        expect(Number(after.net_amount)).toBe(48.5);
        expect(after.bank_reference_no).toBe('BR-1');
        expect(after.unique_reference_no).toBe('UR-1');
        expect(after.gateway_status).toBe(4);
        expect(after.settled_at).not.toBeNull();

        // Receipt BEFORE the feed row — the ordering both call sites document.
        expect(sent.map((s) => s.channel)).toEqual(['email', 'customer_feed']);
      });

      it('a replay credits nothing more, re-claims nothing and posts no second feed row', async () => {
        const row = await seed('2');
        await applyDepositOutcome(scope, row, settled());
        const firstSendCount = sent.length;

        // The SAME row object a retried callback would hold — its `status` is
        // still the stale 'pending' the caller read.
        const replay = await applyDepositOutcome(scope, row, settled());

        expect(replay).toEqual({ applied: true, replayed: true });
        const credits = await service.listCreditTransactions(
          { customer_id: row.customer_id },
          { take: 10 },
        );
        expect(credits).toHaveLength(1);
        const entries = await service.listLedgerEntries(
          { customer_id: row.customer_id },
          { take: 10 },
        );
        expect(entries).toHaveLength(1);
        // The receipt is re-handed to the notification module (its own
        // idempotency_key dedupes it there); the feed row is NOT.
        expect(sent.filter((s) => s.channel === 'customer_feed')).toHaveLength(
          1,
        );
        expect(sent.length).toBe(firstSendCount + 1);
      });

      // The two sources, side by side. They are NOT interchangeable and the
      // difference is the whole reason `source` exists: a callback is an
      // unsolicited POST whose amount is attacker-influenced, a requery is the
      // gateway's own record read by us. Swap either expectation and you have
      // either a forgeable credit or a stranded payment on production's only
      // crediting path.
      it("source 'callback': refuses an amount that is not the row amount — no credit, no row change", async () => {
        const row = await seed('3');

        for (const amount of [49, 51, 10001]) {
          await expect(
            applyDepositOutcome(scope, row, settled({ amount })),
          ).resolves.toEqual({ applied: false, reason: 'amount-mismatch' });
        }

        expect(
          await service.listCreditTransactions(
            { customer_id: row.customer_id },
            { take: 10 },
          ),
        ).toHaveLength(0);
        expect((await reread(row.id)).status).toBe('pending');
        expect(sent).toEqual([]);
      });

      it("source 'requery': credits the OBSERVED amount when it disagrees with the row", async () => {
        const row = await seed('3b');

        const result = await applyDepositOutcome(
          scope,
          row,
          settled({ source: 'requery', amount: 60 }),
        );

        expect(result).toEqual({ applied: true, replayed: false });
        // The observed sum, in the ledger AND in the row mirror — the row
        // asked for 50.
        const credits = await service.listCreditTransactions(
          { customer_id: row.customer_id },
          { take: 10 },
        );
        expect(credits).toHaveLength(1);
        expect(Number(credits[0].amount)).toBe(60);
        const after = await reread(row.id);
        expect(after.status).toBe('settled');
        expect(Number(after.amount_settled)).toBe(60);
      });

      it('refuses a non-positive or unparseable amount from EITHER source', async () => {
        const row = await seed('4');

        // The one guard both sources share: no sum a caller can name here is
        // a payment, and NaN (an unparseable requery) passes every `>` test
        // upstream, so nothing else would stop it reaching the ledger.
        for (const source of ['callback', 'requery'] as const) {
          for (const amount of [0, -5, Number('abc')]) {
            await expect(
              applyDepositOutcome(scope, row, settled({ source, amount })),
            ).resolves.toEqual({
              applied: false,
              reason: 'amount-not-positive',
            });
          }
        }
        expect((await reread(row.id)).status).toBe('pending');
        expect(
          await service.listCreditTransactions(
            { customer_id: row.customer_id },
            { take: 10 },
          ),
        ).toHaveLength(0);
      });

      it('settles a written-off row from the status the caller read, not from pending', async () => {
        // The callback route's recovery branch and the sweep's second scan
        // tier both arrive here with an 'expired' row. A hardcoded 'pending'
        // claim would match nothing and leave the credit committed against a
        // row that still says we gave up.
        const row = await seed('5', 'expired');

        const result = await applyDepositOutcome(scope, row, settled());

        expect(result).toEqual({ applied: true, replayed: false });
        expect((await reread(row.id)).status).toBe('settled');
      });
    });

    describe('the failed / expired outcome', () => {
      it('closes the row without touching the ledger', async () => {
        const row = await seed('6');

        const result = await applyDepositOutcome(scope, row, {
          state: 'failed',
          gatewayTransactionId: 'tx-late',
        });

        expect(result).toEqual({ applied: true, replayed: false });
        const after = await reread(row.id);
        expect(after.status).toBe('failed');
        expect(after.gateway_transaction_id).toBe('tx-late');
        expect(
          await service.listCreditTransactions(
            { customer_id: row.customer_id },
            { take: 10 },
          ),
        ).toHaveLength(0);
        expect(sent).toEqual([]);
      });

      it('loses the claim when the row already moved — the replay answer', async () => {
        const row = await seed('7');
        await service.updateGatewayDeposits({
          id: row.id,
          status: 'settled' as const,
        });

        // `row` still carries the stale 'pending' the caller read.
        await expect(
          applyDepositOutcome(scope, row, { state: 'expired' }),
        ).resolves.toEqual({ applied: true, replayed: true });
        expect((await reread(row.id)).status).toBe('settled');
      });
    });
  },
});
