import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import type { MedusaContainer } from '@medusajs/framework/types';
import { MercurModules, SellerStatus } from '@mercurjs/types';
import {
  createSalesChannelsWorkflow,
  createShippingProfilesWorkflow,
  createStockLocationsWorkflow,
} from '@medusajs/medusa/core-flows';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'card-sprite-attach-test-pw-1'; // gitleaks:allow — throwaway test-DB admin
const ADMIN_EMAIL = 'admin-card-sprite-attach@test.dev';

// The card ↔ sprite attach, end to end through the real admin routes and
// workflows: whichever library row the operator picks — a One Piece BASE
// sprite, a One Piece VARIANT (Gear 5), or a Pokémon — is EXACTLY the row the
// card links, its image is the card's sprite, and only a Pokémon puts a dex on
// the card. The store APIs then serve that same sprite.

// Same catalog prerequisites as card-inherits-pc.spec.ts.
async function ensureCatalogPrereqs(container: MedusaContainer) {
  const salesChannels = container.resolve(Modules.SALES_CHANNEL);
  const fulfillment = container.resolve(Modules.FULFILLMENT);
  const stockLocations = container.resolve(Modules.STOCK_LOCATION);
  const sellers = container.resolve<{
    listSellers: (f: { handle: string }) => Promise<Array<{ id: string }>>;
    createSellers: (data: unknown[]) => Promise<Array<{ id: string }>>;
  }>(MercurModules.SELLER);

  if (
    !(
      await salesChannels.listSalesChannels(
        { name: 'Default Sales Channel' },
        { take: 1 },
      )
    ).length
  ) {
    await createSalesChannelsWorkflow(container).run({
      input: { salesChannelsData: [{ name: 'Default Sales Channel' }] },
    });
  }
  if (!(await fulfillment.listShippingProfiles({}, { take: 1 })).length) {
    await createShippingProfilesWorkflow(container).run({
      input: { data: [{ name: 'Default Shipping Profile', type: 'default' }] },
    });
  }
  if (!(await stockLocations.listStockLocations({}, { take: 1 })).length) {
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
  if (!(await sellers.listSellers({ handle: 'house' })).length) {
    await sellers.createSellers([
      {
        name: 'House',
        handle: 'house',
        email: 'house@polycards.local',
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
    describe('a card links EXACTLY the picked sprite (One Piece base / variant / Pokémon)', () => {
      let adminToken: string;
      let storeHeaders: Record<string, string>;
      const admin = () => ({
        headers: { authorization: `Bearer ${adminToken}` },
      });

      beforeEach(async () => {
        const container = getContainer();
        await ensureCatalogPrereqs(container);
        adminToken = await mintSuperAdmin(
          container,
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        const key = await container.resolve(Modules.API_KEY).createApiKeys({
          title: 'card-sprite-attach',
          type: 'publishable',
          created_by: 'card-sprite-attach',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        await container
          .resolve<PacksModuleService>(PACKS_MODULE)
          .createFxRates([
            {
              pair: 'USD_MYR',
              rate: 4,
              source: 'test',
              fetched_at: new Date(),
              manual_override: true,
              manual_rate: 4,
            },
          ]);
      });

      const sprite = async (body: Record<string, unknown>) => {
        const res = await unwrapResponse(
          api.post('/admin/pixel-pokemon', body, admin()),
        );
        expect(res.status).toBe(201);
        return res.data.pixel_pokemon as { id: string; image_url: string };
      };
      // A PriceCharting product staged with a sprite (the from-PC flow), then
      // registered as a card — optionally with an explicit pick that must win.
      const registerCard = async (
        pcId: string,
        name: string,
        set: string,
        stagedSpriteId: string,
        explicitSpriteId?: string,
      ) => {
        const p = await unwrapResponse(
          api.post(
            '/admin/products/from-pricecharting',
            {
              pc_product_id: pcId,
              pc_grade: 'PSA 10',
              name,
              set,
              grader: 'PSA',
              grade: '10',
              market_value: 100,
              image: 'https://example.com/card.png',
              pixel_pokemon_id: stagedSpriteId,
            },
            admin(),
          ),
        );
        expect(p.status).toBeLessThan(300);
        const reg = await unwrapResponse(
          api.post(
            '/admin/cards',
            {
              product_id: p.data.product.id,
              set,
              grader: 'PSA',
              grade: '10',
              market_value: 100,
              ...(explicitSpriteId
                ? { pixel_pokemon_id: explicitSpriteId }
                : {}),
            },
            admin(),
          ),
        );
        expect(reg.status).toBeLessThan(300);
        return p.data.product.handle as string;
      };
      const cardOf = async (handle: string) =>
        (await unwrapResponse(api.get(`/admin/cards/${handle}`, admin()))).data
          .card;

      it('One Piece: the staged VARIANT, an explicit BASE pick, and relinks all land exactly', async () => {
        const luffy = await sprite({
          name: 'Monkey D. Luffy',
          franchise: 'one-piece',
          number: 1,
          variant: 'normal',
          types: ['One Piece'],
          image_url: 'https://cdn.example/luffy.gif',
        });
        const gear5 = await sprite({
          name: 'Monkey D. Luffy (Gear 5)',
          franchise: 'one-piece',
          number: 1,
          variant: 'gear-5',
          types: ['One Piece'],
          image_url: 'https://cdn.example/luffy-gear5.gif',
        });

        // staged Gear 5 → the registered card inherits the VARIANT, not the base
        const h1 = await registerCard(
          '9001',
          'Monkey.D.Luffy OP05-119',
          'One Piece Awakening of the New Era',
          gear5.id,
        );
        expect(await cardOf(h1)).toMatchObject({
          pixel_pokemon_id: gear5.id,
          sprite_image: 'https://cdn.example/luffy-gear5.gif',
          pokemon_dex: null,
        });

        // staged Gear 5, operator explicitly picks the BASE at register → base wins
        const h2 = await registerCard(
          '9002',
          'Monkey.D.Luffy OP01-024',
          'One Piece Romance Dawn',
          gear5.id,
          luffy.id,
        );
        expect(await cardOf(h2)).toMatchObject({
          pixel_pokemon_id: luffy.id,
          sprite_image: 'https://cdn.example/luffy.gif',
          pokemon_dex: null,
        });

        // card edit: relink h2 to the variant, then unlink
        const edit = (pixel_pokemon_id: string | null) =>
          unwrapResponse(
            api.post(
              `/admin/cards/${h2}`,
              {
                name: 'Monkey.D.Luffy OP01-024',
                set: 'One Piece Romance Dawn',
                grader: 'PSA',
                grade: '10',
                market_value: 100,
                image: 'https://example.com/card.png',
                pixel_pokemon_id,
              },
              admin(),
            ),
          );
        expect((await edit(gear5.id)).status).toBeLessThan(300);
        expect(await cardOf(h2)).toMatchObject({
          pixel_pokemon_id: gear5.id,
          sprite_image: 'https://cdn.example/luffy-gear5.gif',
          pokemon_dex: null,
        });
        expect((await edit(null)).status).toBeLessThan(300);
        expect(await cardOf(h2)).toMatchObject({
          pixel_pokemon_id: null,
          sprite_image: null,
          pokemon_dex: null,
        });

        // the store serves the attached variant for h1 — card detail and pack pool
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: 'op-attach-pack',
            title: 'OP Attach',
            category: 'one-piece',
            price: 10,
            image: '/cdn/p.webp',
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: 'op-attach-pack',
            card_id: h1,
            weight: 100,
            locked: false,
            rarity: 'Legendary' as const,
          },
        ]);
        const storeCard = await unwrapResponse(
          api.get(`/store/cards/${h1}`, { headers: storeHeaders }),
        );
        expect(storeCard.status).toBe(200);
        expect(storeCard.data.card).toMatchObject({
          sprite_image: 'https://cdn.example/luffy-gear5.gif',
          pokemon_dex: null,
        });
        const storePack = await unwrapResponse(
          api.get('/store/packs/op-attach-pack', { headers: storeHeaders }),
        );
        expect(storePack.status).toBe(200);
        expect(JSON.stringify(storePack.data)).toContain(
          'https://cdn.example/luffy-gear5.gif',
        );
      });

      it('Pokémon: the picked entry links with its dex (behaviour unchanged)', async () => {
        const charizard = await sprite({
          name: 'Charizard',
          dex: 6,
          image_url: 'https://cdn.example/charizard.gif',
        });
        const h = await registerCard(
          '9003',
          'Charizard #4',
          'Pokemon Base Set',
          charizard.id,
        );
        expect(await cardOf(h)).toMatchObject({
          pixel_pokemon_id: charizard.id,
          sprite_image: 'https://cdn.example/charizard.gif',
          pokemon_dex: 6,
        });
        const storeCard = await unwrapResponse(
          api.get(`/store/cards/${h}`, { headers: storeHeaders }),
        );
        expect(storeCard.data.card).toMatchObject({
          sprite_image: 'https://cdn.example/charizard.gif',
          pokemon_dex: 6,
        });
      });
    });
  },
});
