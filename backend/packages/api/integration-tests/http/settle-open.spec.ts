import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";

jest.setTimeout(120 * 1000);

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe("settleOpen — locked debit, behavior-preserving", () => {
      it("debits exactly like mutateCreditAtomic and stamps the open id", async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const cust = "cus_settle";
        await packs.mutateCreditAtomic({
          customerId: cust, amount: 100, reason: "topup", reference: "mock_se",
        });
        const r = await packs.settleOpen({
          customerId: cust, amount: -40, sourceTransactionId: "open_settle_1",
        });
        expect(r.balance).toBe(60);
        expect(r.commissions).toEqual([]);
        const summary = await packs.creditSummary(cust);
        expect(summary.balance).toBe(60);
        expect(summary.externalFundedSpendTotal).toBe(40); // external consumed
        const [row] = await packs.listCreditTransactions(
          { customer_id: cust, reason: "pack_open" }, { take: 1, order: { created_at: "DESC" } },
        );
        expect((row as { source_transaction_id?: string | null }).source_transaction_id)
          .toBe("open_settle_1");
      });

      it("rejects a non-negative settle amount (a settle is always a debit)", async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await expect(
          packs.settleOpen({ customerId: "cus_bad", amount: 5, sourceTransactionId: "x" }),
        ).rejects.toThrow(/less than 0/);
      });

      it("enforces the floor (no overdraft) and names price/balance/shortfall", async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        // cus_short has RM 3 and tries a RM 25 open — the error must name the
        // pack price, the current balance, and the exact top-up shortfall
        // (sim day-3 LOW, ux-friction).
        await packs.mutateCreditAtomic({
          customerId: "cus_short", amount: 3, reason: "topup", reference: "mock_short",
        });
        await expect(
          packs.settleOpen({ customerId: "cus_short", amount: -25, sourceTransactionId: "y" }),
        ).rejects.toThrow(
          "Not enough credits to open this pack. It costs RM 25.00 and " +
            "you have RM 3.00 — top up at least RM 22.00.",
        );
      });
    });
  },
});
