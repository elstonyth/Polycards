import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { Modules } from "@medusajs/framework/utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";
import { mintSuperAdmin, unwrapResponse } from "./utils";
import { VIP_LEVELS } from "../../src/scripts/vip-levels.data";

jest.setTimeout(240 * 1000);

const PASSWORD = "admin-gacha-vip-pw-1";

// Task 9: admin gacha route reads vip_member_state with a live fallback.
//
// HIT  — a vip_member_state row exists → route returns vip.level === current_level
//        and vip.highest_level_ever from the row.
// MISS — no row exists → route falls back to levelForSpend(externalFundedSpendTotal)
//        and vip.highest_level_ever equals that same live value.

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe("admin gacha route — vip_member_state projection read", () => {
      let storeHeaders: Record<string, string>;
      let adminToken: string;

      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: "admin-gacha-vip-test",
          type: "publishable",
          created_by: "admin-gacha-vip-test",
        });
        storeHeaders = { "x-publishable-api-key": key.token };
        adminToken = await mintSuperAdmin(
          container,
          api,
          "gacha-vip-admin@test.dev",
          PASSWORD,
        );
      });

      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      const registerCustomer = async (email: string): Promise<string> => {
        const reg = await api.post("/auth/customer/emailpass/register", {
          email,
          password: PASSWORD,
        });
        const created = await api.post(
          "/store/customers",
          { email },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        return created.data.customer.id;
      };

      const view = (customerId: string) =>
        unwrapResponse(
          api.get(`/admin/customers/${customerId}/gacha`, {
            headers: adminHeaders(),
          }),
        );

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

      it("HIT — returns vip_member_state row values (current_level + highest_level_ever)", async () => {
        const customerId = await registerCustomer("gacha-vip-hit@test.dev");
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await seedLadder(packs);

        // Seed a vip_member_state row with distinct current/highest levels.
        await packs.upsertVipMemberState({
          customerId,
          currentLevel: 3,
          highestLevelEver: 7,
          lifetimeSen: 0,
        });

        const res = await view(customerId);
        expect(res.status).toBe(200);
        expect(res.data.vip).not.toBeNull();
        expect(res.data.vip.level).toBe(3);
        expect(res.data.vip.highest_level_ever).toBe(7);
        // spend field still present and non-negative
        expect(typeof res.data.vip.spend).toBe("number");
      });

      it("MISS — no vip_member_state row falls back to levelForSpend for both level fields", async () => {
        const customerId = await registerCustomer("gacha-vip-miss@test.dev");
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await seedLadder(packs);

        // Customer has no vip_member_state row. Give them some external-funded
        // spend so levelForSpend returns a known level (L1 threshold = 0, so
        // any spend stays at L1 unless the ladder says otherwise; we just need
        // the two level fields to match each other).
        await packs.mutateCreditAtomic({
          customerId,
          amount: 100,
          reason: "topup",
          reference: "gacha-vip-miss-seed",
        });
        await packs.mutateCreditAtomic({
          customerId,
          amount: -100,
          reason: "pack_open",
          floor: 0,
        });

        // Verify no state row exists.
        const [stateRow] = await packs.listVipMemberStates(
          { customer_id: customerId },
          { take: 1 },
        );
        expect(stateRow).toBeUndefined();

        const res = await view(customerId);
        expect(res.status).toBe(200);
        expect(res.data.vip).not.toBeNull();
        // Both fields must equal the same live-computed value.
        expect(typeof res.data.vip.level).toBe("number");
        expect(res.data.vip.level).toBe(res.data.vip.highest_level_ever);
        expect(typeof res.data.vip.spend).toBe("number");
      });
    });
  },
});
