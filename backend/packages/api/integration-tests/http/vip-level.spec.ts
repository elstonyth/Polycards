import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { VIP_LEVELS } from '../../src/scripts/vip-levels.data';
import { levelForSpend } from '../../src/modules/packs/vip-ladder';

jest.setTimeout(240 * 1000);

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    it('derives the VIP level from cumulative pack-open spend', async () => {
      const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
      const customerId = 'cus_vip_test_1';

      // Seed the ladder rows this test needs (idempotent-ish for the in-memory DB).
      await packs.createVipLevels(VIP_LEVELS.map((r) => ({ ...r })));

      // A topup (+) then two pack opens (-) => spendTotal = 2300 MYR.
      await packs.createCreditTransactions([
        { customer_id: customerId, amount: 5000, reason: 'topup' },
        { customer_id: customerId, amount: -2254, reason: 'pack_open' },
        { customer_id: customerId, amount: -46, reason: 'pack_open' },
      ]);

      const summary = await packs.creditSummary(customerId);
      expect(summary.spendTotal).toBe(2300);

      const ladder = await packs.listVipLevels(
        {},
        { select: ['level', 'spend_threshold'], take: 1000 },
      );
      expect(
        levelForSpend(
          summary.spendTotal,
          ladder.map((r) => ({
            level: r.level,
            spend_threshold: Number(r.spend_threshold),
          })),
        ),
      ).toBe(10); // 2300 >= L10 threshold 2254
    });
  },
});
