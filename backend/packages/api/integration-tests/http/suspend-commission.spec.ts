import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";
import { VIP_LEVELS } from "../../src/scripts/vip-levels.data";

jest.setTimeout(180 * 1000);

medusaIntegrationTestRunner({
  inApp: true,
  env: { COMMISSION_COOLDOWN_DAYS: "0" }, // immediate maturity
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

    describe("suspend/unsuspend commission", () => {
      it(
        "suspend re-locks an available commission (availableBalance drops); unsuspend restores by maturity predicate",
        async () => {
          const packs =
            getContainer().resolve<PacksModuleService>(PACKS_MODULE);
          await seedLadder(packs);
          const recruit = "cust_su_recruit";
          const sponsor = "cust_su_sponsor";
          await packs.mutateCreditAtomic({
            customerId: recruit,
            amount: 100,
            reason: "topup",
          });
          await packs.linkSponsor({
            recruitId: recruit,
            sponsorId: sponsor,
          });
          await packs.settleOpen({
            customerId: recruit,
            amount: -50,
            sourceTransactionId: "open_su_1",
          });
          const [comm] = await packs.listCommissions(
            { source_transaction_id: "open_su_1", beneficiary: sponsor },
            { take: 1 },
          );
          expect(comm).toBeDefined();
          const before = await packs.availableBalance(sponsor); // matured (cooldown 0) → available
          expect(before).toBeGreaterThan(0);

          // Suspend: commission becomes locked → available balance drops to 0.
          await packs.suspendCommission({
            commissionId: comm.id,
            adminId: "admin_x",
            reason: "review",
          });
          expect(await packs.availableBalance(sponsor)).toBe(0); // suspended ⇒ locked
          const [s1] = await packs.listCommissions(
            { id: comm.id },
            { take: 1 },
          );
          expect(s1.status).toBe("suspended");

          // Audit row must exist for suspend.
          const [auditSuspend] = await packs.listAdminActionAudits(
            { entity_id: comm.id, action: "suspend_commission" },
            { take: 1 },
          );
          expect(auditSuspend?.admin_id).toBe("admin_x");

          // Unsuspend: matures_at in the past (cooldown 0) → status becomes available.
          await packs.unsuspendCommission({
            commissionId: comm.id,
            adminId: "admin_x",
            reason: "cleared",
          });
          const [s2] = await packs.listCommissions(
            { id: comm.id },
            { take: 1 },
          );
          expect(s2.status).toBe("available"); // matures_at in the past (cooldown 0)
          expect(await packs.availableBalance(sponsor)).toBeCloseTo(before);

          // Audit row must exist for unsuspend.
          const [auditUnsuspend] = await packs.listAdminActionAudits(
            { entity_id: comm.id, action: "unsuspend_commission" },
            { take: 1 },
          );
          expect(auditUnsuspend?.admin_id).toBe("admin_x");
        },
      );

      it("suspendCommission rejects a reversed commission", async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await seedLadder(packs);
        const recruit = "cust_su2_recruit";
        const sponsor = "cust_su2_sponsor";
        await packs.mutateCreditAtomic({
          customerId: recruit,
          amount: 100,
          reason: "topup",
        });
        await packs.linkSponsor({ recruitId: recruit, sponsorId: sponsor });
        await packs.settleOpen({
          customerId: recruit,
          amount: -50,
          sourceTransactionId: "open_su_2",
        });
        const [comm] = await packs.listCommissions(
          { source_transaction_id: "open_su_2", beneficiary: sponsor },
          { take: 1 },
        );
        // Reverse the commission first.
        await packs.reverseCommission({
          commissionId: comm.id,
          adminId: "admin_x",
          reason: "fraud",
        });
        // Now try to suspend — must be rejected.
        await expect(
          packs.suspendCommission({
            commissionId: comm.id,
            adminId: "admin_x",
            reason: "late review",
          }),
        ).rejects.toThrow();
      });

      it("unsuspendCommission rejects a non-suspended commission", async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await seedLadder(packs);
        const recruit = "cust_su3_recruit";
        const sponsor = "cust_su3_sponsor";
        await packs.mutateCreditAtomic({
          customerId: recruit,
          amount: 100,
          reason: "topup",
        });
        await packs.linkSponsor({ recruitId: recruit, sponsorId: sponsor });
        await packs.settleOpen({
          customerId: recruit,
          amount: -50,
          sourceTransactionId: "open_su_3",
        });
        const [comm] = await packs.listCommissions(
          { source_transaction_id: "open_su_3", beneficiary: sponsor },
          { take: 1 },
        );
        // Commission is 'available', not 'suspended' — unsuspend must be rejected.
        await expect(
          packs.unsuspendCommission({
            commissionId: comm.id,
            adminId: "admin_x",
            reason: "oops",
          }),
        ).rejects.toThrow();
      });
    });
  },
});
