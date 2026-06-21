import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";

jest.setTimeout(120 * 1000);

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe("credit_transaction.source_transaction_id", () => {
      it("persists and reads back the open id stamped on a charge", async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cust = "cus_srctxn";
        const openId = "open_test_0001";
        await packs.mutateCreditAtomic({
          customerId: cust, amount: 100, reason: "topup", reference: "mock_s",
        });
        await packs.mutateCreditAtomic({
          customerId: cust, amount: -25, reason: "pack_open", floor: 0,
          sourceTransactionId: openId,
        });
        const [row] = await packs.listCreditTransactions(
          { customer_id: cust }, { take: 1, order: { created_at: "DESC" } },
        );
        expect(
          (row as { source_transaction_id?: string | null }).source_transaction_id,
        ).toBe(openId);
      });
    });
  },
});
