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

        // Spec 2 §5 (id-only): stage the pixel-Pokémon by a PixelPokemon library
        // id (not a raw dex); the route mirrors the pick onto product metadata
        // for the gacha-card registration step to inherit.
        const pp = await unwrapResponse(
          api.post(
            '/admin/pixel-pokemon',
            {
              name: 'Charizard',
              dex: 6,
              image_url: 'https://example.com/charizard-pixel.png',
            },
            adminHeaders(),
          ),
        );
        const pixelId = pp.data.pixel_pokemon.id as string;

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
              pixel_pokemon_id: pixelId,
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
        // NO multiplier, and stages the pixel-Pokémon PICK (its library id) for
        // the register step to inherit and mirror.
        expect(prod.data.product.metadata.market_multiplier).toBeUndefined();
        expect(prod.data.product.metadata.pixel_pokemon_id).toBe(pixelId);

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

      it('rejects creation without a pixel_pokemon_id', async () => {
        // Business rule (2026-07-11): a from-PC product must carry its pixel
        // Pokémon at add-time. The old "resolves from the card name" fallback
        // fails on suffixed PC names (e.g. "Blastoise ex #200") and ships a
        // card with no reel sprite — so the route now rejects instead.
        const res = await unwrapResponse(
          api.post(
            '/admin/products/from-pricecharting',
            {
              pc_product_id: '6912',
              pc_grade: 'PSA 10',
              name: 'Blastoise ex #200',
              set: 'Scarlet & Violet 151',
              grader: 'PSA',
              grade: '10',
              market_value: 60,
              image: 'https://example.com/blastoise.png',
            },
            adminHeaders(),
          ),
        );
        expect(res.status).toBe(400);
        expect(res.data.message).toContain('pixel_pokemon_id');
      });

      // The money fields are capped server-side (plans 004/015 lineage): FMV
      // drives the listing price (FMV × FX), so a direct API client can't mint
      // a listing at an arbitrary price. These caps fire BEFORE the pixel-null
      // check, so no staged pixel is needed to reach them.
      it('rejects market_value above the cap', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/products/from-pricecharting',
            {
              pc_product_id: '6910',
              pc_grade: 'PSA 10',
              name: 'Charizard',
              image: 'https://example.com/charizard.png',
              market_value: 200_000,
              pixel_pokemon_id: 'pp_whatever',
            },
            adminHeaders(),
          ),
        );
        expect(res.status).toBe(400);
        expect(res.data.message).toContain("'market_value' must be at most");
      });

      it('rejects price above the cap', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/products/from-pricecharting',
            {
              pc_product_id: '6910',
              pc_grade: 'PSA 10',
              name: 'Charizard',
              image: 'https://example.com/charizard.png',
              market_value: 100,
              price: 200_000,
              pixel_pokemon_id: 'pp_whatever',
            },
            adminHeaders(),
          ),
        );
        expect(res.status).toBe(400);
        expect(res.data.message).toContain("'price' must be at most");
      });

      it('rejects stock above the cap', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/products/from-pricecharting',
            {
              pc_product_id: '6910',
              pc_grade: 'PSA 10',
              name: 'Charizard',
              image: 'https://example.com/charizard.png',
              market_value: 100,
              stock: 10_001,
              pixel_pokemon_id: 'pp_whatever',
            },
            adminHeaders(),
          ),
        );
        expect(res.status).toBe(400);
        expect(res.data.message).toContain("'stock' must be at most");
      });

      // A well-formed but nonexistent id passes the type/trim guard, then would
      // degrade to name-derivation at card registration (a spriteless card).
      // Resolving at add-time — when the entry is guaranteed to exist — rejects
      // it up front instead.
      it('rejects a well-formed but nonexistent pixel_pokemon_id', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/products/from-pricecharting',
            {
              pc_product_id: '6910',
              pc_grade: 'PSA 10',
              name: 'Charizard',
              image: 'https://example.com/charizard.png',
              market_value: 100,
              pixel_pokemon_id: 'pp_does_not_exist',
            },
            adminHeaders(),
          ),
        );
        expect(res.status).toBe(400);
        expect(res.data.message).toContain(
          'does not match a PixelPokemon library entry',
        );
      });
    });
  },
});
