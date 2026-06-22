import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";
import { VIP_LEVELS } from "../../src/scripts/vip-levels.data";

jest.setTimeout(180 * 1000);

medusaIntegrationTestRunner({
  inApp: true,
  env: { COMMISSION_COOLDOWN_DAYS: "0" }, // matured immediately
  testSuite: ({ getContainer }) => {
    async function seedLadder(packs: PacksModuleService) {
      const existing = await packs.listVipLevels({}, { take: 1 });
      if (existing.length === 0) {
        await packs.createVipLevels(
          VIP_LEVELS.map((r) => ({
            level: r.level, spend_threshold: r.spend_threshold,
            voucher_amount: r.voucher_amount, box_tier: r.box_tier,
            frame_unlock: r.frame_unlock, direct_referral_pct: r.direct_referral_pct,
            prizes: r.prizes ?? null,
          })),
        );
      }
    }

    describe("reverseOpen — cascading commission reversal", () => {
      it("claws back the debit + every commission generation, idempotently", async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await seedLadder(packs);
        const recruit = "cus_rv_recruit", s1 = "cus_rv_s1", s2 = "cus_rv_s2", s3 = "cus_rv_s3";
        await packs.linkSponsor({ recruitId: recruit, sponsorId: s1 });
        await packs.linkSponsor({ recruitId: s1, sponsorId: s2 });
        await packs.linkSponsor({ recruitId: s2, sponsorId: s3 });
        await packs.mutateCreditAtomic({
          customerId: recruit, amount: 100, reason: "topup", reference: "mock_rv",
        });
        await packs.settleOpen({ customerId: recruit, amount: -100, sourceTransactionId: "open_rv" });
        // Sanity: paid (s1=RM1, s2=RM0.20, s3=RM0.04).
        expect(await packs.creditBalance(s1)).toBe(1);

        // Reverse the whole open: debit refund + 3 commission claw-backs.
        const res = await packs.reverseOpen("open_rv");
        expect(res.reversed).toBe(4);

        // Recruit refunded; every sponsor clawed back to 0.
        expect(await packs.creditBalance(recruit)).toBe(100); // 100 - 100 + 100 refund
        for (const c of [s1, s2, s3]) {
          expect(await packs.creditBalance(c)).toBe(0);
          // 2-term reconciliation: reversed is NOT locked -> available == balance.
          expect(await packs.availableBalance(c)).toBe(await packs.creditBalance(c));
        }

        // Lifecycle rows all reversed + anchored.
        const comms = await packs.listCommissions({ source_transaction_id: "open_rv" }, { take: 10 });
        expect(comms.length).toBe(3);
        expect(comms.every((c) => c.status === "reversed")).toBe(true);
        expect(comms.every((c) => c.reversal_transaction_id != null)).toBe(true);

        // Idempotent: a second reverse appends nothing.
        const res2 = await packs.reverseOpen("open_rv");
        expect(res2.reversed).toBe(0);
        expect(await packs.creditBalance(s1)).toBe(0);
      });

      it("drives a beneficiary negative when a matured commission was already spent", async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await seedLadder(packs);
        const recruit = "cus_neg_recruit", s1 = "cus_neg_s1";
        await packs.linkSponsor({ recruitId: recruit, sponsorId: s1 });
        await packs.mutateCreditAtomic({
          customerId: recruit, amount: 100, reason: "topup", reference: "mock_neg",
        });
        await packs.settleOpen({ customerId: recruit, amount: -100, sourceTransactionId: "open_neg" });
        // s1 earned RM1 (available). s1 spends it — its credit is internal
        // (external_funded_cents 0) so no onward commission is paid.
        await packs.settleOpen({ customerId: s1, amount: -1, sourceTransactionId: "open_neg_s1_spend" });
        expect(await packs.creditBalance(s1)).toBe(0);

        // Reverse the recruit's open -> claws back s1's spent RM1 -> s1 goes negative.
        await packs.reverseOpen("open_neg");
        expect(await packs.creditBalance(s1)).toBe(-1);
        expect(await packs.availableBalance(s1)).toBe(-1);

        // Further opens blocked while negative.
        await expect(
          packs.settleOpen({ customerId: s1, amount: -1, sourceTransactionId: "open_neg_blocked" }),
        ).rejects.toThrow();
      });
    });
  },
});
