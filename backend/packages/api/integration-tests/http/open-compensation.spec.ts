import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";

jest.setTimeout(120 * 1000);

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe("open compensation = append-only reversal, never delete", () => {
      it("reverseCreditTransaction appends a mirror row and restores balance + basis", async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cust = "cus_comp_revert";

        // Fund externally, then debit a pack_open through the locked path.
        await packs.mutateCreditAtomic({
          customerId: cust, amount: 100, reason: "topup", reference: "mock_comp",
        });
        const { id: chargeId } = await packs.mutateCreditAtomic({
          customerId: cust, amount: -30, reason: "pack_open", floor: 0,
        });
        const mid = await packs.creditSummary(cust);
        expect(mid.balance).toBe(70);
        expect(mid.externalFundedSpendTotal).toBe(30);

        // Reverse — must NOT soft-delete; must append a mirror row.
        await packs.reverseCreditTransaction(chargeId);

        const original = await packs.listCreditTransactions({ id: chargeId }, { take: 1 });
        expect(original.length).toBe(1); // original still present (not deleted)

        const after = await packs.creditSummary(cust);
        expect(after.balance).toBe(100); // refunded
        expect(after.externalFundedSpendTotal).toBe(0); // VIP basis netted (Task 1)

        const rows = await packs.listCreditTransactions(
          { customer_id: cust }, { take: 100, order: { created_at: "ASC" } },
        );
        const reversal = rows.find(
          (r) => (r.reference ?? "") === `reversal:${chargeId}`,
        );
        expect(reversal).toBeTruthy();
        expect(Number(reversal!.amount)).toBe(30); // +30 mirrors the -30 charge
      });

      it("is idempotent: a repeated compensation does not double-refund", async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cust = "cus_comp_idem";

        await packs.mutateCreditAtomic({
          customerId: cust, amount: 100, reason: "topup", reference: "mock_comp_idem",
        });
        const { id: chargeId } = await packs.mutateCreditAtomic({
          customerId: cust, amount: -30, reason: "pack_open", floor: 0,
        });

        // Compensate twice for the SAME charge (a saga that double-compensates).
        const first = await packs.reverseCreditTransaction(chargeId);
        const second = await packs.reverseCreditTransaction(chargeId);

        // Second call is a no-op returning the same reversal — no second refund.
        expect(second.id).toBe(first.id);

        const reversals = await packs.listCreditTransactions(
          { reference: `reversal:${chargeId}` }, { take: 10 },
        );
        expect(reversals.length).toBe(1); // exactly one reversal row

        const after = await packs.creditSummary(cust);
        expect(after.balance).toBe(100); // refunded once, not 130
        expect(after.externalFundedSpendTotal).toBe(0);
      });
    });
  },
});
