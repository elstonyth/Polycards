import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearFxDisplayCache } from '../../src/modules/packs/pricing';
import { clearAdminPackListCache } from '../../src/api/admin/packs/route';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Store desk reports (spec 2026-09-29-desk-reports-design.md, Phase B), each
// locked to the admin page that already shows the same numbers: the pack list
// (GET /admin/packs) and the inventory list (GET /admin/inventory).
const STORE_KEY = 's'.repeat(48);
const GROWTH_KEY = 'g'.repeat(48);
process.env.REPORT_KEY_STORE = STORE_KEY;
process.env.REPORT_KEY_GROWTH = GROWTH_KEY;
process.env.DESK_REPORTS_RATE_BURST_LIMIT = '1000';
process.env.DESK_REPORTS_RATE_LIMIT = '6000';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    const packs = () =>
      getContainer().resolve<PacksModuleService>(PACKS_MODULE);
    const report = (path: string, key: string | null = STORE_KEY) =>
      unwrapResponse(
        api.get(`/reports/store/${path}`, {
          headers: key ? { 'x-report-key': key } : {},
        }),
      );
    let adminToken: string;
    const admin = (path: string) =>
      unwrapResponse(
        api.get(path, { headers: { authorization: `Bearer ${adminToken}` } }),
      );

    beforeEach(async () => {
      clearFxDisplayCache();
      clearAdminPackListCache();
      adminToken = await mintSuperAdmin(
        getContainer(),
        api,
        'desk-reports-store@test.dev',
        'desk-reports-store-pw-1', // gitleaks:allow
      );
    });

    describe('the store key', () => {
      it('opens store reports and nothing else opens them', async () => {
        expect((await report('packs')).status).toBe(200);
        expect((await report('packs', GROWTH_KEY)).status).toBe(401);
        expect((await report('packs', null)).status).toBe(401);
      });
    });

    describe('packs', () => {
      beforeEach(async () => {
        await packs().createPacks([
          {
            slug: 'st-active',
            title: 'ST Active',
            category: 'pokemon',
            price: 20,
            image: '/x.webp',
            status: 'active' as const,
            in_stock: false,
          },
          {
            slug: 'st-draft',
            title: 'ST Draft',
            category: 'pokemon',
            price: 10,
            image: '/x.webp',
            status: 'draft' as const,
          },
          {
            slug: 'st-reward',
            title: 'ST Reward',
            category: 'reward_box',
            price: 0,
            image: '/x.webp',
            status: 'active' as const,
          },
        ]);
        await packs().createCards([
          {
            handle: 'st-x',
            name: 'ST Hit',
            set: 'S',
            grader: 'PSA',
            grade: '10',
            market_value: 50,
            image: '/x.webp',
          },
          {
            handle: 'st-y',
            name: 'ST Common',
            set: 'S',
            grader: 'PSA',
            grade: '9',
            market_value: 3,
            image: '/x.webp',
          },
        ]);
        await packs().createPackOdds([
          {
            pack_id: 'st-active',
            card_id: 'st-x',
            rarity: 'Legendary' as const,
            weight: 100,
            weight_2: 400,
            top_hit_order: 1,
          },
          {
            pack_id: 'st-active',
            card_id: 'st-y',
            rarity: 'Common' as const,
            weight: 900,
          },
        ]);
      });

      it('matches the admin pack list for odds set 1 and the published odds, and shows nothing else', async () => {
        const list = await admin('/admin/packs');
        expect(list.status).toBe(200);
        const dash = (list.data.packs as Array<Record<string, any>>).find(
          (p) => p.slug === 'st-active',
        )!;
        const res = await report('packs');
        expect(res.status).toBe(200);
        const rows = res.data.packs as Array<Record<string, unknown>>;
        const mine = rows.find((p) => p.slug === 'st-active')!;
        expect(mine).toMatchObject({
          title: 'ST Active',
          status: 'active',
          listed_publicly: true,
          sold_out_badge: true,
          price: 20,
          ev: dash.ev.s1,
          rtp_pct: dash.rtp.s1,
          published_ev: dash.pub_ev,
          published_rtp_pct: dash.pub_rtp,
        });
        expect(mine.ev).not.toBeNull();
        expect(rows.find((p) => p.slug === 'st-draft')!.listed_publicly).toBe(
          false,
        );
        expect(rows.find((p) => p.slug === 'st-reward')!.listed_publicly).toBe(
          false,
        );
        const body = JSON.stringify(res.data);
        for (const hidden of ['weight', '"s2"', '"s3"', 'target_rtp', 'cost']) {
          expect(body).not.toContain(hidden);
        }
      });

      it('shows one pack: its pool by rarity and its top hits, never the weights', async () => {
        const res = await report('pack?slug=st-active');
        expect(res.status).toBe(200);
        expect(res.data.pack).toMatchObject({ slug: 'st-active', price: 20 });
        expect(
          res.data.by_rarity.map((t: { rarity: string; cards: number }) => [
            t.rarity,
            t.cards,
          ]),
        ).toEqual([
          ['Legendary', 1],
          ['Common', 1],
        ]);
        expect(res.data.top_hits).toEqual([
          expect.objectContaining({
            card: 'ST Hit',
            handle: 'st-x',
            rarity: 'Legendary',
          }),
        ]);
        expect(JSON.stringify(res.data)).not.toContain('weight');
        expect((await report('pack?slug=nope-pack')).status).toBe(404);
        expect((await report('pack?slug=Bad Slug!')).status).toBe(400);
      });
    });

    describe('stock', () => {
      it('lists tracked cards at or below max, with the inventory page counts', async () => {
        const productModule = getContainer().resolve(Modules.PRODUCT);
        const card = (handle: string, name: string) =>
          packs().createCards([
            {
              handle,
              name,
              set: 'S',
              grader: 'PSA',
              grade: '10',
              market_value: 10,
              image: '/x.webp',
            },
          ]);
        // UNTRACKED: a product that counts no units. Never "low".
        await productModule.createProducts([
          {
            title: 'ST Untracked',
            handle: 'st-untracked',
            status: ProductStatus.PUBLISHED,
            options: [{ title: 'Format', values: ['Slab'] }],
            variants: [
              {
                title: 'Slab',
                sku: 'ST-UNTRACKED',
                options: { Format: 'Slab' },
              },
            ],
          },
        ]);
        await card('st-untracked', 'ST Untracked');
        // TRACKED AT ZERO: variant + location + item + level + link, as in
        // inventory-detail.spec.
        const [tracked] = await productModule.createProducts([
          {
            title: 'ST Tracked',
            handle: 'st-tracked',
            status: ProductStatus.PUBLISHED,
            options: [{ title: 'Format', values: ['Slab'] }],
            variants: [
              {
                title: 'Slab',
                sku: 'ST-TRACKED',
                manage_inventory: true,
                options: { Format: 'Slab' },
              },
            ],
          },
        ]);
        await card('st-tracked', 'ST Tracked');
        const location = await getContainer()
          .resolve(Modules.STOCK_LOCATION)
          .createStockLocations({ name: 'ST Warehouse' });
        const inventory = getContainer().resolve(Modules.INVENTORY);
        const item = await inventory.createInventoryItems({
          sku: 'ST-TRACKED',
        });
        await inventory.createInventoryLevels([
          {
            inventory_item_id: item.id,
            location_id: location.id,
            stocked_quantity: 0,
          },
        ]);
        await getContainer()
          .resolve(ContainerRegistrationKeys.LINK)
          .create({
            [Modules.PRODUCT]: { variant_id: tracked.variants[0].id },
            [Modules.INVENTORY]: { inventory_item_id: item.id },
          });

        const rows = (await admin('/admin/inventory')).data.rows as Array<{
          handle: string;
          on_hand: number | null;
        }>;
        expect(rows.find((r) => r.handle === 'st-tracked')!.on_hand).toBe(0);
        expect(
          rows.find((r) => r.handle === 'st-untracked')!.on_hand,
        ).toBeNull();

        const res = await report('stock');
        expect(res.status).toBe(200);
        const handles = res.data.cards.map((c: { handle: string }) => c.handle);
        expect(handles).toContain('st-tracked');
        expect(handles).not.toContain('st-untracked');
        expect(
          res.data.cards.find(
            (c: { handle: string }) => c.handle === 'st-tracked',
          ),
        ).toMatchObject({ on_hand: 0, card: 'ST Tracked' });
        expect(JSON.stringify(res.data)).not.toContain('cost');
        // Below the threshold: nothing at -1 or lower here.
        const below = await report('stock?max=-1');
        expect(
          below.data.cards.map((c: { handle: string }) => c.handle),
        ).not.toContain('st-tracked');
      });

      it('refuses a bad max', async () => {
        expect((await report('stock?max=abc')).status).toBe(400);
      });
    });
  },
});
