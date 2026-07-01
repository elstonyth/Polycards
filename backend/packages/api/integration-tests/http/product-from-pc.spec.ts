import { medusaIntegrationTestRunner } from "@medusajs/test-utils";
import { Modules } from "@medusajs/framework/utils";
import type { MedusaContainer } from "@medusajs/framework/types";
import { MercurModules, SellerStatus } from "@mercurjs/types";
import {
  createSalesChannelsWorkflow,
  createShippingProfilesWorkflow,
  createStockLocationsWorkflow,
} from "@medusajs/medusa/core-flows";
import { mintSuperAdmin, unwrapResponse } from "./utils";

jest.setTimeout(240 * 1000);

const PASSWORD = "product-from-pc-test-pw-1";
const ADMIN_EMAIL = "admin-product-from-pc@test.dev";

// This route creates a Product (Mercur marketplace), so it needs the same
// minimal catalog prerequisites the seed script bootstraps: a sales channel,
// a shipping profile, and a "house" seller (createProductsWorkflow's
// additional_data.seller_id needs one to exist).
async function ensureCatalogPrereqs(container: MedusaContainer) {
  const salesChannelService = container.resolve(Modules.SALES_CHANNEL);
  const fulfillmentService = container.resolve(Modules.FULFILLMENT);
  const stockLocationService = container.resolve(Modules.STOCK_LOCATION);
  const sellerService = container.resolve<{
    listSellers: (f: { handle: string }) => Promise<Array<{ id: string }>>;
    createSellers: (data: unknown[]) => Promise<Array<{ id: string }>>;
  }>(MercurModules.SELLER);

  const existingChannels = await salesChannelService.listSalesChannels(
    { name: "Default Sales Channel" },
    { take: 1 },
  );
  if (!existingChannels.length) {
    await createSalesChannelsWorkflow(container).run({
      input: { salesChannelsData: [{ name: "Default Sales Channel" }] },
    });
  }

  const existingProfiles = await fulfillmentService.listShippingProfiles(
    {},
    { take: 1 },
  );
  if (!existingProfiles.length) {
    await createShippingProfilesWorkflow(container).run({
      input: { data: [{ name: "Default Shipping Profile", type: "default" }] },
    });
  }

  const existingLocations = await stockLocationService.listStockLocations(
    {},
    { take: 1 },
  );
  if (!existingLocations.length) {
    await createStockLocationsWorkflow(container).run({
      input: {
        locations: [
          {
            name: "Test Warehouse",
            address: { city: "Kuala Lumpur", country_code: "MY", address_1: "" },
          },
        ],
      },
    });
  }

  const existingSellers = await sellerService.listSellers({ handle: "house" });
  if (!existingSellers.length) {
    await sellerService.createSellers([
      {
        name: "House",
        handle: "house",
        email: "house@pokenic.local",
        currency_code: "myr",
        status: SellerStatus.OPEN,
        metadata: { house: true },
      },
    ]);
  }
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe("POST /admin/products/from-pricecharting", () => {
      let adminToken: string;

      beforeEach(async () => {
        const container = getContainer();
        await ensureCatalogPrereqs(container);
        adminToken = await mintSuperAdmin(container, api, ADMIN_EMAIL, PASSWORD);
      });

      const adminHeaders = () => ({
        headers: { authorization: `Bearer ${adminToken}` },
      });

      it("creates a product with the PC link on metadata (no card)", async () => {
        const res = await unwrapResponse(
          api.post(
            "/admin/products/from-pricecharting",
            {
              pc_product_id: "6910",
              pc_grade: "PSA 10",
              name: "Charizard",
              set: "Base Set",
              grader: "PSA",
              grade: "10",
              market_value: 100,
              image: "https://example.com/charizard.png",
              market_multiplier: 1.2,
            },
            adminHeaders(),
          ),
        );
        expect(res.status).toBe(201);
        expect(res.data.product.handle).toBe("charizard-psa-10");

        const prod = await unwrapResponse(
          api.get(
            `/admin/products/${res.data.product.id}?fields=+metadata`,
            adminHeaders(),
          ),
        );
        expect(prod.data.product.metadata.pc_product_id).toBe("6910");
        expect(prod.data.product.metadata.pc_grade).toBe("PSA 10");
        expect(prod.data.product.metadata.fmv).toBe(100);
        expect(prod.data.product.metadata.market_multiplier).toBe(1.2);
      });
    });
  },
});
