import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';

jest.setTimeout(240 * 1000);

// UQ_credit_txn_keyed_once (Migration20261111120000, audit 2026-11-11): the
// money-in reasons were deduped only by the `credit:` lock plus a SELECT, so
// a writer that skipped mutateCreditAtomic would pay twice. The database now
// refuses the second row. pack_open stays out of it: an open's reversal
// carries the debit's open id on purpose.

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('one credit row per idempotency key', () => {
      const packs = () =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);
      const row = (
        reason: 'topup' | 'reward_credit' | 'pack_open',
        key: string,
        amount: number,
        customer_id = 'cus_keyed_once',
      ) => ({ customer_id, amount, reason, source_transaction_id: key });

      it.each([
        ['topup', 'topup-idem:k1'],
        ['reward_credit', 'task:claim-1'],
      ] as const)(
        'refuses a second %s row under one key',
        async (reason, key) => {
          await packs().createCreditTransactions([row(reason, key, 10)]);
          await expect(
            packs().createCreditTransactions([row(reason, key, 10)]),
          ).rejects.toThrow();
          const rows = await packs().listCreditTransactions({
            source_transaction_id: key,
          });
          expect(rows).toHaveLength(1);
        },
      );

      it('lets two customers hold the same key', async () => {
        await packs().createCreditTransactions([
          row('topup', 'topup-idem:shared', 10, 'cus_a'),
          row('topup', 'topup-idem:shared', 10, 'cus_b'),
        ]);
        const rows = await packs().listCreditTransactions({
          source_transaction_id: 'topup-idem:shared',
        });
        expect(rows).toHaveLength(2);
      });

      it('still lets a pack_open debit and its reversal share the open id', async () => {
        await packs().createCreditTransactions([
          row('pack_open', 'open-keyed-1', -5),
          row('pack_open', 'open-keyed-1', 5),
        ]);
        const rows = await packs().listCreditTransactions({
          source_transaction_id: 'open-keyed-1',
        });
        expect(rows).toHaveLength(2);
      });
    });
  },
});
