import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';

jest.setTimeout(180 * 1000);

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('reverseOpen — saga compensation for a settled open', () => {
      it("refunds the recruit's debit, idempotently", async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const buyer = 'cus_rv_buyer';
        await packs.mutateCreditAtomic({
          customerId: buyer,
          amount: 100,
          reason: 'topup',
          reference: 'mock_rv',
        });
        await packs.settleOpen({
          customerId: buyer,
          amount: -100,
          sourceTransactionId: 'open_rv',
        });
        expect(await packs.creditBalance(buyer)).toBe(0);

        const res = await packs.reverseOpen('open_rv');
        expect(res.reversed).toBe(1);
        expect(await packs.creditBalance(buyer)).toBe(100);
        // Nothing is locked, so available tracks the raw balance exactly.
        expect(await packs.availableBalance(buyer)).toBe(100);

        // Idempotent: a second reverse appends nothing.
        const res2 = await packs.reverseOpen('open_rv');
        expect(res2.reversed).toBe(0);
        expect(await packs.creditBalance(buyer)).toBe(100);
      });

      it('returns reversed: 0 for an open that was never settled', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        expect(await packs.reverseOpen('open_rv_never')).toEqual({
          reversed: 0,
        });
      });
    });
  },
});
