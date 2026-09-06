/**
 * applyWithdrawalOutcome against a REAL Postgres — integration:modules
 *
 * The settle half of the payout loop, the mirror of refundWithdrawal.
 * It moves no money (the debit happened at submit), so its whole correctness
 * is the row: a CONDITIONAL claim off 'pending' that a replay must lose, and
 * a settlement mirror whose bigNumber pair (amount_settled / net_amount, each
 * with a paired raw_* jsonb column) has to actually persist. A fake `em`
 * answers whatever the test says to both, which is why this spec is
 * DB-backed and the two unit specs over the call sites are not.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import GatewayWithdrawal from '../models/gateway-withdrawal';
import CreditTransaction from '../models/credit-transaction';
import LedgerEntry from '../models/ledger-entry';
import LedgerSequence from '../models/ledger-sequence';
import { applyWithdrawalOutcome } from '../gateway-withdrawal';

jest.setTimeout(300 * 1000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  // The ledger tables are here to PROVE the settle path never writes them —
  // an absent table would make that assertion pass for the wrong reason.
  moduleModels: [
    GatewayWithdrawal,
    CreditTransaction,
    LedgerEntry,
    LedgerSequence,
  ],
  testSuite: ({ service }) => {
    let sent: { channel: string; key: string }[] = [];

    // The container the two call sites hand in. Its `resolve` is generic on
    // the production side, so the fake is cast once here rather than at each
    // of the call sites below.
    const resolveFake = (key: string): unknown => {
      if (key === Modules.CUSTOMER) {
        return {
          retrieveCustomer: async () => ({ email: 'payee@example.test' }),
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
      status: 'pending' | 'settled' | 'failed' | 'held' = 'pending',
    ) => {
      const [row] = await service.createGatewayWithdrawals([
        {
          merchant_transaction_id: `PW-OUT-${suffix}`,
          customer_id: `cus_wout_${suffix}`,
          amount: 100,
          bank_code: 'MBB',
          account_number: '1234567890',
          account_holder_name: 'AHMAD BIN ALI',
          gateway_transaction_id: `tx-${suffix}`,
          gateway: 'tgpay',
          status,
        },
      ]);
      return row;
    };

    const reread = async (id: string) =>
      (await service.listGatewayWithdrawals({ id }, { take: 1 }))[0];

    const paid = (over: Record<string, unknown> = {}) =>
      ({
        gatewayRef: 'tx-1',
        settledAt: new Date('2026-09-06T10:00:00.000Z'),
        ...over,
      }) as Parameters<typeof applyWithdrawalOutcome>[2];

    it('settles the row, mirrors the settlement facts and sends one receipt then one feed row', async () => {
      const row = await seed('1');

      const result = await applyWithdrawalOutcome(
        scope,
        row,
        paid({
          amountSettled: 100,
          netAmount: 98.5,
          bankReferenceNo: 'BR-42',
          uniqueReferenceNo: 'UR-43',
          gatewayStatus: 4,
        }),
      );

      expect(result).toEqual({ replayed: false });

      const after = await reread(row.id);
      expect(after.status).toBe('settled');
      expect(Number(after.amount_settled)).toBe(100);
      expect(Number(after.net_amount)).toBe(98.5);
      expect(after.bank_reference_no).toBe('BR-42');
      expect(after.unique_reference_no).toBe('UR-43');
      expect(after.gateway_status).toBe(4);
      expect(after.settled_at).not.toBeNull();

      // Settle never touches money — the debit already happened at submit.
      expect(
        await service.listCreditTransactions(
          { customer_id: row.customer_id },
          { take: 10 },
        ),
      ).toHaveLength(0);

      expect(sent.map((s) => s.channel)).toEqual(['email', 'customer_feed']);
      expect(sent[0].key).toBe(
        `withdrawal-receipt:paid:${row.merchant_transaction_id}`,
      );
      expect(sent[1].key).toBe(
        `withdrawal:${row.merchant_transaction_id}:paid`,
      );
    });

    it('an absent net stores NULL, never a zero fee', async () => {
      const row = await seed('2');

      await applyWithdrawalOutcome(scope, row, paid({ amountSettled: 100 }));

      const after = await reread(row.id);
      expect(after.status).toBe('settled');
      expect(after.net_amount).toBeNull();
      expect(after.bank_reference_no).toBeNull();
      expect(after.unique_reference_no).toBeNull();
    });

    it('a replay loses the claim, answers replayed and posts no second feed row', async () => {
      const row = await seed('3');
      await applyWithdrawalOutcome(scope, row, paid({ amountSettled: 100 }));
      const firstSendCount = sent.length;

      // The same stale-'pending' row object a retried callback would hold.
      const replay = await applyWithdrawalOutcome(
        scope,
        row,
        paid({ amountSettled: 999 }),
      );

      expect(replay).toEqual({ replayed: true });
      // The mirror is NOT overwritten by the loser's numbers.
      expect(Number((await reread(row.id)).amount_settled)).toBe(100);
      expect(sent.filter((s) => s.channel === 'customer_feed')).toHaveLength(1);
      expect(sent.length).toBe(firstSendCount + 1);
    });

    it('never settles a row that is no longer pending', async () => {
      // A payout the sweep refunded a moment ago must not be flipped to
      // 'settled' by a late callback — the claim is the only thing between
      // that row and a report saying the bank paid it.
      const row = await seed('4', 'failed');

      await expect(
        applyWithdrawalOutcome(scope, row, paid({ amountSettled: 100 })),
      ).resolves.toEqual({ replayed: true });
      expect((await reread(row.id)).status).toBe('failed');
    });

    it('stores the gateway id the caller learned, without clearing one already on the row', async () => {
      const row = await seed('5');

      await applyWithdrawalOutcome(
        scope,
        row,
        paid({ gatewayTransactionId: 'tx-from-callback', amountSettled: 100 }),
      );
      expect((await reread(row.id)).gateway_transaction_id).toBe(
        'tx-from-callback',
      );

      const bare = await seed('6');
      await applyWithdrawalOutcome(scope, bare, paid({ amountSettled: 100 }));
      expect((await reread(bare.id)).gateway_transaction_id).toBe('tx-6');
    });
  },
});
