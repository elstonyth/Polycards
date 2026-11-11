/**
 * backfillExternalFundedBasisForCustomer — integration:modules
 *
 * The per-customer restamp behind scripts/backfill-external-funded-basis.ts:
 * grandfathered (NULL) topups get their face value, opens are re-consumed,
 * and every changed row is written in one batched UPDATE.
 */
import path from 'path';
import { moduleIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../index';
import type PacksModuleService from '../service';
import Pack from '../models/pack';
import Card from '../models/card';
import PackOdds from '../models/pack-odds';
import Pull from '../models/pull';
import CreditTransaction from '../models/credit-transaction';
import CustomerAccountState from '../models/customer-account-state';
import AdminActionAudit from '../models/admin-action-audit';

jest.setTimeout(300 * 1000);

moduleIntegrationTestRunner<PacksModuleService>({
  moduleName: PACKS_MODULE,
  resolve: path.resolve(__dirname, '../../..', 'modules/packs'),
  moduleModels: [
    Pack,
    Card,
    PackOdds,
    Pull,
    CreditTransaction,
    CustomerAccountState,
    AdminActionAudit,
  ],
  testSuite: ({ service }) => {
    // A ledger row written straight, the way pre-1b rows sit in the table.
    const row = async (
      customerId: string,
      reason: 'topup' | 'pack_open',
      amount: number,
      ext: number | null,
    ) => {
      const [created] = await service.createCreditTransactions([
        {
          customer_id: customerId,
          amount,
          reason,
          pull_id: null,
          reference: null,
          external_funded_cents: ext,
        } as Record<string, unknown>,
      ]);
      return created.id as string;
    };

    const stampOf = async (id: string) => {
      const [r] = await service.listCreditTransactions({ id });
      return r.external_funded_cents;
    };

    it('restamps every changed row at once and leaves the rest alone', async () => {
      const cus = 'cus_backfill_many';
      const t1 = await row(cus, 'topup', 50, null);
      const t2 = await row(cus, 'topup', 30, null);
      const open = await row(cus, 'pack_open', -20, 0);
      const right = await row(cus, 'topup', 10, 1000);
      const other = await row('cus_backfill_other', 'topup', 40, null);

      const r = await service.backfillExternalFundedBasisForCustomer(cus);

      expect(r).toEqual({ rowsUpdated: 3 });
      expect(await stampOf(t1)).toBe(5000);
      expect(await stampOf(t2)).toBe(3000);
      expect(await stampOf(open)).toBe(-2000);
      expect(await stampOf(right)).toBe(1000);
      // Another customer's grandfathered topup is not this run's.
      expect(await stampOf(other)).toBeNull();

      // Idempotent: the restamped ledger now matches the replay.
      expect(await service.backfillExternalFundedBasisForCustomer(cus)).toEqual(
        { rowsUpdated: 0 },
      );
    });

    it('writes nothing for a ledger that is already right', async () => {
      const cus = 'cus_backfill_clean';
      const t = await row(cus, 'topup', 25, 2500);
      expect(await service.backfillExternalFundedBasisForCustomer(cus)).toEqual(
        { rowsUpdated: 0 },
      );
      expect(await stampOf(t)).toBe(2500);
    });
  },
});
