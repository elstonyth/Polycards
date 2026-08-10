import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Stock is a running counter that may go NEGATIVE (operator request,
// 2026-07-03): every win on a tracked product decrements — even past zero —
// so a negative number is exactly the physical units owed to winners that
// still need sourcing. This pins: a win at stock 0 lands the level at −1,
// the pull is stock_earmarked (so a later buyback restore stays symmetric),
// and the spin itself never fails on inventory.

const PASSWORD = 'stock-neg-test-pw-1';
const PACK_SLUG = 'stock-neg-pack';
const PACK_PRICE = 10;
const CARD_HANDLE = 'stock-neg-card';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('negative stock counter', () => {
      let storeHeaders: Record<string, string>;
      let inventoryItemId: string;
      let locationId: string;

      beforeEach(async () => {
        const container = getContainer();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'stock-neg-test',
          type: 'publishable',
          created_by: 'stock-neg-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        // Single-card pool → deterministic roll.
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'Stock Neg Pack',
            category: 'pokemon',
            price: PACK_PRICE,
            image: '/cdn/test-pack.webp',
            buyback_percent: 90,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'Stock Neg Card PSA 10',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: 50,
            image: '/cdn/test-card.webp',
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: PACK_SLUG,
            card_id: CARD_HANDLE,
            weight: 100,
            locked: false,
            rarity: 'Rare' as const,
          },
        ]);

        // Tracked product mirror at ZERO stock — the win must still count.
        const productModule = container.resolve(Modules.PRODUCT);
        const [product] = await productModule.createProducts([
          {
            title: 'Stock Neg Card PSA 10',
            handle: CARD_HANDLE,
            status: 'published',
            options: [{ title: 'Format', values: ['Slab'] }],
            variants: [
              {
                title: 'Slab',
                sku: `CARD-${CARD_HANDLE.toUpperCase()}`,
                manage_inventory: true,
                options: { Format: 'Slab' },
              },
            ],
          },
        ]);
        const stockLocationModule = container.resolve(Modules.STOCK_LOCATION);
        const location = await stockLocationModule.createStockLocations({
          name: 'Stock Neg Warehouse',
        });
        locationId = location.id;
        const inventoryModule = container.resolve(Modules.INVENTORY);
        const item = await inventoryModule.createInventoryItems({
          sku: `CARD-${CARD_HANDLE.toUpperCase()}`,
        });
        inventoryItemId = item.id;
        await inventoryModule.createInventoryLevels([
          {
            inventory_item_id: item.id,
            location_id: location.id,
            stocked_quantity: 0,
          },
        ]);
        const link = container.resolve(ContainerRegistrationKeys.LINK);
        await link.create({
          [Modules.PRODUCT]: { variant_id: product.variants[0].id },
          [Modules.INVENTORY]: { inventory_item_id: item.id },
        });
      });

      it('a win at 0 stock decrements to −1 and earmarks the pull', async () => {
        const container = getContainer();

        // Register + fund a customer.
        const email = 'stock-neg@test.dev';
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        await postStoreCustomer(
          api,
          getContainer(),
          { email },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        const login = await api.post('/auth/customer/emailpass', {
          email,
          password: PASSWORD,
        });
        const authed = {
          ...storeHeaders,
          authorization: `Bearer ${login.data.token}`,
        };
        const topup = await unwrapResponse(
          api.post(
            '/store/credits/topup',
            { amount: 2 * PACK_PRICE },
            { headers: { ...authed, 'idempotency-key': 'stock-neg-topup' } },
          ),
        );
        expect(topup.status).toBe(200);

        // Two wins on a 0-stock card — both succeed, counter goes −1 then −2.
        const first = await unwrapResponse(
          api.post(`/store/packs/${PACK_SLUG}/open`, {}, { headers: authed }),
        );
        expect(first.status).toBe(200);
        const second = await unwrapResponse(
          api.post(`/store/packs/${PACK_SLUG}/open`, {}, { headers: authed }),
        );
        expect(second.status).toBe(200);

        const inventoryModule = container.resolve(Modules.INVENTORY);
        const level =
          await inventoryModule.retrieveInventoryLevelByItemAndLocation(
            inventoryItemId,
            locationId,
          );
        expect(Number(level.stocked_quantity)).toBe(-2);

        // Both pulls took a unit — buyback's +1 restore stays symmetric.
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        const pulls = await packs.listPulls(
          { card_id: CARD_HANDLE },
          { take: 10 },
        );
        expect(pulls).toHaveLength(2);
        for (const pull of pulls) {
          expect(
            (pull as unknown as { stock_earmarked: boolean }).stock_earmarked,
          ).toBe(true);
        }
      });
    });
  },
});
