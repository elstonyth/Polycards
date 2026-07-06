import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import type { MedusaContainer } from '@medusajs/framework/types';
import { MercurModules, SellerStatus } from '@mercurjs/types';
import {
  createSalesChannelsWorkflow,
  createShippingProfilesWorkflow,
  createStockLocationsWorkflow,
} from '@medusajs/medusa/core-flows';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'product-from-pc-test-pw-1';
const ADMIN_EMAIL = 'admin-product-from-pc@test.dev';

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
    { name: 'Default Sales Channel' },
    { take: 1 },
  );
  if (!existingChannels.length) {
    await createSalesChannelsWorkflow(container).run({
      input: { salesChannelsData: [{ name: 'Default Sales Channel' }] },
    });
  }

  const existingProfiles = await fulfillmentService.listShippingProfiles(
    {},
    { take: 1 },
  );
  if (!existingProfiles.length) {
    await createShippingProfilesWorkflow(container).run({
      input: { data: [{ name: 'Default Shipping Profile', type: 'default' }] },
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
            name: 'Test Warehouse',
            address: {
              city: 'Kuala Lumpur',
              country_code: 'MY',
              address_1: '',
            },
          },
        ],
      },
    });
  }

  const existingSellers = await sellerService.listSellers({ handle: 'house' });
  if (!existingSellers.length) {
    await sellerService.createSellers([
      {
        name: 'House',
        handle: 'house',
        email: 'house@pokenic.local',
        currency_code: 'myr',
        status: SellerStatus.OPEN,
        metadata: { house: true },
      },
    ]);
  }
}

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('POST /admin/products/from-pricecharting', () => {
      let adminToken: string;

      beforeEach(async () => {
        const container = getContainer();
        await ensureCatalogPrereqs(container);
        adminToken = await mintSuperAdmin(
          container,
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
      });

      const adminHeaders = () => ({
        headers: { authorization: `Bearer ${adminToken}` },
      });

      it('creates a product with the PC link on metadata (no card)', async () => {
        // Pin FX so the no-markup listing price is a deterministic golden
        // vector: FMV 100 × FX 4.0 × NO margin = RM 400.
        const fxPost = await unwrapResponse(
          api.post(
            '/admin/pricing/fx',
            { manual_override: true, manual_rate: 4.0, reason: 'test: pin FX' },
            adminHeaders(),
          ),
        );
        expect(fxPost.status).toBe(200);

        const res = await unwrapResponse(
          api.post(
            '/admin/products/from-pricecharting',
            {
              pc_product_id: '6910',
              pc_grade: 'PSA 10',
              name: 'Charizard',
              set: 'Base Set',
              grader: 'PSA',
              grade: '10',
              market_value: 100,
              image: 'https://example.com/charizard.png',
              pokemon_dex: 6,
            },
            adminHeaders(),
          ),
        );
        expect(res.status).toBe(201);
        expect(res.data.product.handle).toBe('charizard-psa-10-6910');

        const prod = await unwrapResponse(
          api.get(
            `/admin/products/${res.data.product.id}?fields=+metadata`,
            adminHeaders(),
          ),
        );
        expect(prod.data.product.metadata.pc_product_id).toBe('6910');
        expect(prod.data.product.metadata.pc_grade).toBe('PSA 10');
        expect(prod.data.product.metadata.fmv).toBe(100);
        // Margin moved to gacha-card registration — product creation stores
        // NO multiplier, and stages the pixel-Pokémon pick for inheritance.
        expect(prod.data.product.metadata.market_multiplier).toBeUndefined();
        expect(prod.data.product.metadata.pokemon_dex).toBe(6);

        // Listing price is plain FMV × FX (no markup) and the default stock
        // is 0 — units are counted when the physical slabs are in hand.
        const query = getContainer().resolve('query');
        const { data } = await query.graph({
          entity: 'product',
          fields: [
            'variants.prices.amount',
            'variants.inventory_items.inventory.location_levels.stocked_quantity',
          ],
          filters: { id: res.data.product.id },
        });
        // Structural cast: query.graph's inferred variant type depends on the
        // generated .mercur/index.d.ts, which differs between a fresh checkout
        // and a dev-booted tree — pin the shape we actually selected.
        const variant = data[0].variants?.[0] as
          | {
              prices?: { amount: unknown }[];
              inventory_items?: {
                inventory?: {
                  location_levels?: { stocked_quantity?: unknown }[];
                };
              }[];
            }
          | undefined;
        const amounts = (variant?.prices ?? []).map((p: { amount: unknown }) =>
          Number(p.amount),
        );
        expect(amounts).toContain(400);
        const stocked =
          variant?.inventory_items?.[0]?.inventory?.location_levels?.[0]
            ?.stocked_quantity;
        expect(Number(stocked)).toBe(0);
      });
    });
  },
});
