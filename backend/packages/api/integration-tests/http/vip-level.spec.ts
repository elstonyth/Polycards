import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { VIP_LEVELS } from '../../src/scripts/vip-levels.data';

jest.setTimeout(240 * 1000);

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    async function seedLadder(packs: PacksModuleService) {
      const existing = await packs.listVipLevels({}, { take: 1 });
      if (existing.length === 0) {
        await packs.createVipLevels(
          VIP_LEVELS.map((r) => ({
            level: r.level,
            spend_threshold: r.spend_threshold,
            voucher_amount: r.voucher_amount,
            box_tier: r.box_tier,
            frame_unlock: r.frame_unlock,
            direct_referral_pct: r.direct_referral_pct,
            prizes: r.prizes ?? null,
          })),
        );
      }
    }

    describe('VIP level basis = external-funded spend', () => {
      it('external-funded opens raise the level; buyback-funded opens do not', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await seedLadder(packs);

        const cust = 'cus_vip_extfund';
        // Top-up enough external credit to clear a few rungs, then open it.
        await packs.mutateCreditAtomic({
          customerId: cust,
          amount: 3000,
          reason: 'topup',
          reference: 'mock_vip',
        });
        await packs.mutateCreditAtomic({
          customerId: cust,
          amount: -3000,
          reason: 'pack_open',
          floor: 0,
        });
        const summary = await packs.creditSummary(cust);
        expect(summary.externalFundedSpendTotal).toBe(3000);

        // A buyback-funded open must NOT add to the basis.
        await packs.createCreditTransactions([
          {
            customer_id: cust,
            amount: 500,
            reason: 'buyback' as const,
            pull_id: 'pull_vip_extfund',
            reference: null,
          },
        ]);
        await packs.mutateCreditAtomic({
          customerId: cust,
          amount: -500,
          reason: 'pack_open',
          floor: 0,
        });
        const after = await packs.creditSummary(cust);
        expect(after.externalFundedSpendTotal).toBe(3000); // unchanged
        expect(after.spendTotal).toBe(3500); // raw spend DID grow
      });
    });
  },
});
