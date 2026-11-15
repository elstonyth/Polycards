/**
 * The credit lock on a real database (integration:modules): two concurrent
 * debits cannot both pass the floor, and a posting composed onto a
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
  testSuite: ({ service }) => {
    const inTxn = <T>(fn: (ctx: Context) => Promise<T>): Promise<T> =>
      (service as unknown as { baseRepository_: { transaction: (f: (tm: unknown) => Promise<T>) => Promise<T> } })
        .baseRepository_.transaction((transactionManager) => fn({ transactionManager } as Context));
    const balance = async (customerId: string) => (await service.creditSummary(customerId)).balance;

    it('two concurrent debits on one balance: exactly one wins', async () => {
      const c = 'cus_lock_race';
      await service.createCreditTransactions([{ customer_id: c, amount: 10, reason: 'topup', external_funded_cents: 1000 }]);
      const debit = () => service.mutateCreditAtomic({ customerId: c, amount: -8, reason: 'adjustment', floor: 0 });
      const results = await within(30_000, Promise.allSettled([debit(), debit()]));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(String((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason))
        .toMatch(/Deduction exceeds/);
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
