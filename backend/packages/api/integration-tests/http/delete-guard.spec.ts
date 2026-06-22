import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";

jest.setTimeout(120 * 1000);

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe("delete-guard refuses to delete a charge with dependent commission", () => {
      it("throws when a credit_transaction has a commission row", async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [charge] = await packs.createCreditTransactions([
          {
            customer_id: "cus_dg", amount: -10, reason: "pack_open" as const,
            pull_id: null, reference: null, source_transaction_id: "open_dg_1",
          } as Record<string, unknown>,
        ]);
        const [credit] = await packs.createCreditTransactions([
          {
            customer_id: "cus_dg_sponsor", amount: 1, reason: "direct_referral" as const,
            pull_id: null, reference: null, source_transaction_id: "open_dg_1", generation: 1,
          } as Record<string, unknown>,
        ]);
        await packs.createCommissions([
          {
            credit_transaction_id: credit.id, beneficiary: "cus_dg_sponsor",
            source_transaction_id: "open_dg_1", generation: 1, kind: "direct",
            status: "available", matures_at: new Date(), effective_pct: 1,
          } as Record<string, unknown>,
        ]);
        // Deleting the credit row that backs a commission must be refused with
        // the specific guard error (not just any throw).
        await expect(
          packs.deleteCreditTransactionsGuarded([credit.id]),
        ).rejects.toThrow(/backs a commission/);
        // A row with no dependents still deletes fine (resolves without throwing).
        await expect(packs.deleteCreditTransactionsGuarded([charge.id])).resolves.toBeUndefined();
      });
    });
  },
});
