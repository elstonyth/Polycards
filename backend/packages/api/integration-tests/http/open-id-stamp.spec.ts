import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { PACKS_MODULE } from "../../src/modules/packs";
import type PacksModuleService from "../../src/modules/packs/service";
import { openPackWorkflow } from "../../src/workflows/open-pack";

jest.setTimeout(120 * 1000);

// Fixture constants matching pack-open-charge.spec.ts (the canonical priced-pack
// fixture in this repo). Using the same identifiers keeps the pattern consistent
// and avoids inventing a new seeding path.
const PACK_SLUG = "oid-pack";
const CARD_HANDLE = "oid-card";
const PACK_PRICE = 10;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe("open workflow stamps a per-open source_transaction_id on the charge", () => {
      beforeEach(async () => {
        const container = getContainer();
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

        // Seed a minimal priced pack with one card + 100-weight odds so the
        // roll is deterministic (only one card can win).
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: "Open-ID Test Pack",
            category: "pokemon",
            price: PACK_PRICE,
            image: "/cdn/oid-pack.webp",
            buyback_percent: 96,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: "Open-ID Test Card PSA 10",
            set: "Test Set",
            grader: "PSA",
            grade: "10",
            market_value: 50,
            image: "/cdn/oid-card.webp",
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: PACK_SLUG,
            card_id: CARD_HANDLE,
            weight: 100,
            locked: false,
            rarity: "Rare" as const,
          },
        ]);
      });

      it("a paid open writes a pack_open row carrying a non-null open id", async () => {
        const container = getContainer();
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);

        const cust = "cus_openid_test";
        // Fund the customer enough to open one pack.
        await packs.mutateCreditAtomic({
          customerId: cust,
          amount: 1000,
          reason: "topup",
          reference: "mock_oid_topup",
        });

        await openPackWorkflow(container).run({
          input: { pack_id: PACK_SLUG, customer_id: cust },
        });

        // Anchor on the pack_open charge explicitly (not "latest row") so the
        // assertion is order-independent.
        const [charge] = await packs.listCreditTransactions(
          { customer_id: cust, reason: "pack_open" },
          { take: 1, order: { created_at: "DESC" } },
        );
        expect(charge.reason).toBe("pack_open");
        const sid = (charge as { source_transaction_id?: string | null })
          .source_transaction_id;
        // open_id is a v4 uuid minted in the workflow transform seam (Task 4).
        expect(sid).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
      });
    });
  },
});
