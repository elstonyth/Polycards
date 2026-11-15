/**
 * The credit lock on a real database (integration:modules): a debit that
 * overlaps a transaction holding the lock waits for it, then sees its write,
 * so two debits cannot both pass the floor, and a posting composed onto a
 * transaction that already holds the lock re-enters it instead of waiting on
 * itself. Both carry a deadline, so a regression fails instead of hanging.
 */

import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import type { Context } from '@medusajs/framework/types';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import CreditTransaction from '../models/credit-transaction';
import CustomerAccountState from '../models/customer-account-state';
import { lockCredit } from '../credit-posting';

jest.setTimeout(120 * 1000);

const within = <T>(ms: number, work: Promise<T>): Promise<T> =>
  Promise.race([
    work,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no result within ${ms} ms`)), ms)),
  ]);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [CreditTransaction, CustomerAccountState],
  testSuite: ({ service, MikroOrmWrapper }) => {
    const inTxn = <T>(fn: (ctx: Context) => Promise<T>): Promise<T> =>
      (service as unknown as { baseRepository_: { transaction: (f: (tm: unknown) => Promise<T>) => Promise<T> } })
        .baseRepository_.transaction((transactionManager) => fn({ transactionManager } as Context));
    const balance = async (customerId: string) => (await service.creditSummary(customerId)).balance;

    it('two overlapping debits on one balance: the second waits for the lock, then loses', async () => {
      const c = 'cus_lock_race';
      await service.createCreditTransactions([{ customer_id: c, amount: 10, reason: 'topup', external_funded_cents: 1000 }]);
      const debit = (ctx?: Context) => service.mutateCreditAtomic({ customerId: c, amount: -8, reason: 'adjustment', floor: 0 }, ctx);
      // Force the overlap: hold the lock in one transaction, start the second
      // debit on its own, and prove from pg_stat_activity that it is waiting
      // on the advisory lock before the first one writes. Without the lock the
      // second debit would read RM 10 too, and both would pass the floor.
      const em = MikroOrmWrapper.forkManager();
      const observer = MikroOrmWrapper.forkManager();
      await em.begin();
      let pending: Promise<unknown> | undefined;
      try {
        const held = { transactionManager: em } as unknown as Context;
        await lockCredit(held, c);
        pending = debit().catch((error: unknown) => error);
        let waiting = false;
        for (let attempt = 0; attempt < 150 && !waiting; attempt++) {
          const [row] = await observer.execute<{ waiting: boolean }[]>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE wait_event = 'advisory' AND query LIKE ?) AS waiting", [`%credit:${c}%`]);
          waiting = row.waiting;
          if (!waiting) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(waiting).toBe(true);
        await debit(held);
        await em.commit();
      } catch (error) {
        if (em.isInTransaction()) await em.rollback();
        if (pending) await pending;
        throw error;
      }
      expect(String(await within(30_000, pending!))).toMatch(/Deduction exceeds/);
      expect(await balance(c)).toBe(2);
    });

    it('a posting inside a transaction that already holds the lock does not deadlock', async () => {
      const c = 'cus_lock_reentrant';
      const res = await within(15_000, inTxn(async (ctx) => {
        await lockCredit(ctx, c);
        return service.mutateCreditAtomic({ customerId: c, amount: 5, reason: 'adjustment' }, ctx);
      }));
      expect(res).toMatchObject({ balance: 5, replayed: false });
      expect(await balance(c)).toBe(5);
    });
  },
});
