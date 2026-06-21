import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";

jest.setTimeout(120 * 1000);

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe("commission idempotency index on credit_transaction", () => {
      it("rejects a duplicate direct_referral for the same (open, beneficiary, gen)", async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const base = {
          customer_id: "cus_sponsor",
          amount: 5,
          reason: "direct_referral" as const,
          pull_id: null,
          reference: null,
          source_transaction_id: "open_idem_1",
          generation: 1,
        } as Record<string, unknown>;
        await packs.createCreditTransactions([base]);
        await expect(packs.createCreditTransactions([{ ...base }])).rejects.toThrow();
      });
    });
  },
});
