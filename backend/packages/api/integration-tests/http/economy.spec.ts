import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";
import { mintSuperAdmin, unwrapResponse } from "./utils";

jest.setTimeout(240 * 1000);

// Economy report: GET /admin/economy returns lifetime ledger totals, the
// outstanding vault liability, and a per-active-pack theoretical RTP table —
// all from directly-seeded rows so every number is exactly predictable.

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe("admin economy report", () => {
      let adminToken: string;

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          "economy-admin@test.dev",
          "economy-test-password-1",
        );
      });

      const economy = (headers: Record<string, string>) =>
        unwrapResponse(api.get("/admin/economy", { headers }));

      it("rejects an unauthenticated read with 401", async () => {
        expect((await economy({})).status).toBe(401);
      });

      it("reports exact totals, liability, and per-pack RTP", async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);

        // Ledger: $100 topup, two opens (-$25, -$25), one buyback (+$11.61),
        // one adjustment (+$5) → revenue 50, payouts 11.61, net 38.39.
        await packs.createCreditTransactions([
          {
            customer_id: "cus_a",
            amount: 100,
            reason: "topup" as const,
            pull_id: null,
            reference: "ref",
          },
          {
            customer_id: "cus_a",
            amount: -25,
            reason: "pack_open" as const,
            pull_id: null,
            reference: null,
          },
          {
            customer_id: "cus_a",
            amount: -25,
            reason: "pack_open" as const,
            pull_id: null,
            reference: null,
          },
          {
            customer_id: "cus_a",
            amount: 11.61,
            reason: "buyback" as const,
            pull_id: null,
            reference: null,
          },
          {
            customer_id: "cus_a",
            amount: 5,
            reason: "adjustment" as const,
            pull_id: null,
            reference: "grant",
          },
        ]);

        // Cards: $10 and $30 FMV. Vault: TWO vaulted pulls of the $10 card
        // (liability 20) and one bought-back (excluded).
        await packs.createCards([
          {
            handle: "eco-low",
            name: "Eco Low",
            set: "QA",
            grader: "PSA",
            grade: "9",
            market_value: 10,
            image: "/qa.png",
          },
          {
            handle: "eco-high",
            name: "Eco High",
            set: "QA",
            grader: "PSA",
            grade: "10",
            market_value: 30,
            image: "/qa.png",
          },
        ]);
        await packs.createPulls([
          {
            customer_id: "cus_a",
            pack_id: "eco-pack",
            card_id: "eco-low",
            status: "vaulted" as const,
            rolled_at: new Date(),
          },
          {
            customer_id: "cus_a",
            pack_id: "eco-pack",
            card_id: "eco-low",
            status: "vaulted" as const,
            rolled_at: new Date(),
          },
          {
            customer_id: "cus_a",
            pack_id: "eco-pack",
            card_id: "eco-high",
            status: "bought_back" as const,
            buyback_amount: 27,
            rolled_at: new Date(),
          },
        ]);

        // Pack: $25, 50/50 odds over the two cards → EV 20, RTP 80%. A draft
        // pack must NOT appear in the table.
        await packs.createPacks([
          {
            slug: "eco-pack",
            title: "Eco Pack",
            category: "pokemon",
            price: 25,
            image: "/qa.png",
            status: "active" as const,
            rank: 0,
          },
          {
            slug: "eco-draft",
            title: "Eco Draft",
            category: "pokemon",
            price: 25,
            image: "/qa.png",
            status: "draft" as const,
            rank: 1,
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: "eco-pack",
            card_id: "eco-low",
            rarity: "Common" as const,
            weight: 5000,
            locked: false,
          },
          {
            pack_id: "eco-pack",
            card_id: "eco-high",
            rarity: "Rare" as const,
            weight: 5000,
            locked: false,
          },
        ]);

        const res = await economy({ authorization: `Bearer ${adminToken}` });
        expect(res.status).toBe(200);

        expect(res.data.totals).toEqual({
          revenue: 50,
          payouts: 11.61,
          topups: 100,
          adjustments: 5,
          net: 38.39,
        });

        expect(res.data.liability).toEqual({ count: 2, market_value: 20 });

        expect(res.data.packs).toHaveLength(1);
        expect(res.data.packs[0]).toMatchObject({
          slug: "eco-pack",
          price: 25,
          ev: 20,
          rtp_pct: 80,
        });
      });
    });
  },
});
