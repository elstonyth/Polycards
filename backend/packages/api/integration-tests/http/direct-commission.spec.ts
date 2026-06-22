import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";
import { VIP_LEVELS } from "../../src/scripts/vip-levels.data";

jest.setTimeout(180 * 1000);

medusaIntegrationTestRunner({
  inApp: true,
  env: { COMMISSION_COOLDOWN_DAYS: "0" }, // demo: immediate maturity
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

    describe("direct commission inside settleOpen", () => {
      it("credits the sponsor immediately-available when a recruit opens", async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await seedLadder(packs);
        const sponsor = "cus_dc_sponsor";
        const recruit = "cus_dc_recruit";
        await packs.linkSponsor({ recruitId: recruit, sponsorId: sponsor });

        // Recruit funds externally so the basis is external-funded.
        await packs.mutateCreditAtomic({
          customerId: recruit, amount: 100, reason: "topup", reference: "mock_dc",
        });
        // Recruit opens RM100. Sponsor is L1 (spend 0) → 1% → RM1 = 100 sen.
        const r = await packs.settleOpen({
          customerId: recruit, amount: -100, sourceTransactionId: "open_dc_1",
        });
        expect(r.commissions).toEqual([
          { beneficiary: sponsor, amountSen: 100, matured: true },
        ]);

        // Sponsor wallet: RM1, available NOW (cooldown 0).
        expect(await packs.creditBalance(sponsor)).toBe(1);
        expect(await packs.availableBalance(sponsor)).toBe(1);

        // A commission lifecycle row exists, status available, gen 1.
        const [comm] = await packs.listCommissions(
          { source_transaction_id: "open_dc_1" }, { take: 1 },
        );
        expect(comm.beneficiary).toBe(sponsor);
        expect(comm.generation).toBe(1);
      });

      it("is idempotent: replaying the same open_id pays the sponsor once", async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await seedLadder(packs);
        const sponsor = "cus_idem_sponsor";
        const recruit = "cus_idem_recruit";
        await packs.linkSponsor({ recruitId: recruit, sponsorId: sponsor });
        await packs.mutateCreditAtomic({
          customerId: recruit, amount: 200, reason: "topup", reference: "mock_idem",
        });
        await packs.settleOpen({ customerId: recruit, amount: -50, sourceTransactionId: "open_dup" });
        // Replay the SAME open_id MUST reject and roll back: the 23505 on the
        // commission idempotency index aborts the whole settleOpen txn, so the
        // duplicate's debit is undone too (the debit is not separately keyed).
        await expect(
          packs.settleOpen({ customerId: recruit, amount: -50, sourceTransactionId: "open_dup" }),
        ).rejects.toThrow();
        const comms = await packs.listCommissions(
          { source_transaction_id: "open_dup" }, { take: 10 },
        );
        expect(comms.length).toBe(1); // exactly one commission for that open
        // No double-debit: 200 topup − 50 (first open) = 150; the replay rolled back.
        expect(await packs.creditBalance(recruit)).toBe(150);
      });

      it("pays no commission when the recruit has no sponsor", async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await seedLadder(packs);
        const solo = "cus_solo";
        await packs.mutateCreditAtomic({
          customerId: solo, amount: 100, reason: "topup", reference: "mock_solo",
        });
        const r = await packs.settleOpen({ customerId: solo, amount: -100, sourceTransactionId: "open_solo" });
        expect(r.commissions).toEqual([]);
      });
    });
  },
});
