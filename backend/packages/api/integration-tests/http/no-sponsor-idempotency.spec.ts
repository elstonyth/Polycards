// integration-tests/http/no-sponsor-idempotency.spec.ts
// Integration test — no-sponsor debit idempotency (Phase 3b Task 1).
// A replayed open_id with NO sponsor must throw DUPLICATE_ERROR,
// not silently double-debit (the commission index never fires if there is no
// sponsor, so a separate debit index + widened try/catch are required).
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';

jest.setTimeout(120 * 1000);

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('no-sponsor debit idempotency', () => {
      let packs: PacksModuleService;

      beforeEach(() => {
        packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
      });

      it('a replayed no-sponsor open settles exactly once (no double-debit)', async () => {
        const customerId = 'cus_nosp_1';
        const openId = 'open_nosp_1';

        // Fund the wallet — mutateCreditAtomic takes amount in USD (not sen),
        // externalFundedSen is not a param; topup auto-populates external_funded_cents.
        await packs.mutateCreditAtomic({
          customerId,
          amount: 100, // $100.00 = 10_000 sen
          reason: 'topup',
        });

        // settleOpen amount is signed USD decimal (negative = debit).
        // -$50.00 = -5_000 sen
        await packs.settleOpen({
          customerId,
          amount: -50,
          sourceTransactionId: openId,
        });

        // Replay the SAME open_id — must throw (already been settled).
        await expect(
          packs.settleOpen({
            customerId,
            amount: -50,
            sourceTransactionId: openId,
          }),
        ).rejects.toThrow(/already been settled/i);

        // One debit only: balance should be $50.00 (5_000 sen).
        const summary = await packs.creditSummary(customerId);
        expect(Math.round(summary.balance * 100)).toBe(5_000);
      });

      it('an open and its reverseOpen share a source_transaction_id without colliding', async () => {
        const customerId = 'cus_nosp_2';
        const openId = 'open_nosp_2';

        await packs.mutateCreditAtomic({
          customerId,
          amount: 100, // $100.00
          reason: 'topup',
        });

        const result = await packs.settleOpen({
          customerId,
          amount: -50, // -$50.00
          sourceTransactionId: openId,
        });

        // reverseOpen writes a POSITIVE pack_open reversal row with the same
        // source_transaction_id — excluded by the amount<0 predicate on the new
        // index, so no collision.
        await expect(packs.reverseOpen(openId)).resolves.toBeDefined();
        expect(result.id).toBeTruthy();
      });
    });
  },
});
