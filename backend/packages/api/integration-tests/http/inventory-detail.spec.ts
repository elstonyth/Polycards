import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearFxDisplayCache } from '../../src/modules/packs/pricing';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'inventory-detail-test-pw-1'; // gitleaks:allow
const ADMIN_EMAIL = 'inventory-detail-admin@test.dev';

const FX = 4.5;

// NOTE ON TEST NAMES: none of them contains a regex metacharacter. `jest -t`
// is a REGEX, so a name carrying one silently matches nothing and reports
// green (Task 4's lesson). Run this file BY PATH and check the printed count.

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET /admin/inventory/:handle', () => {
      let adminToken: string;
      let packs: PacksModuleService;

      beforeEach(async () => {
        packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        // LOAD-BEARING here, not merely defensive as in inventory-list.spec: a
        // fresh test DB has no fx_rate row, so POST /admin/purchase-invoices'
        // resolveFxRateStrict throws NOT_ALLOWED ("Exchange rate
        // unavailable") and every fixture invoice below would fail. It ALSO
        // makes the money assertions discriminate against the
        // DEFAULT_USD_MYR = 4.7 fallback.
        await unwrapResponse(
          api.post(
            '/admin/pricing/fx',
            { manual_override: true, manual_rate: FX, reason: 'pin for test' },
            { headers: { authorization: `Bearer ${adminToken}` } },
          ),
        );
        // The FX route does not evict the 30s display cache and the runner
        // truncates the DB between tests, so without this a later test's
        // fmv/price can pass on the previous test's rate.
        clearFxDisplayCache();
      });

      const headers = () => ({
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const getDetail = (handle: string, qs = '') =>
        unwrapResponse(api.get(`/admin/inventory/${handle}${qs}`, headers()));

      // The list's grain is PRODUCTS: a Card with no Product counterpart is
      // not a row, so every fixture below starts with a real product.
      const makeProduct = async (
        handle: string,
        title: string,
        extra: Record<string, unknown> = {},
      ) => {
        const productModule = getContainer().resolve(Modules.PRODUCT);
        const [product] = await productModule.createProducts([
          { title, handle, status: ProductStatus.PUBLISHED, ...extra },
        ]);
        return product;
      };

      const buy = (
        card_handle: string,
        card_name: string,
        qty: number,
        unit_cost: number,
      ) =>
        unwrapResponse(
          api.post(
            '/admin/purchase-invoices',
            {
              date: '2026-07-28T00:00:00.000Z',
              supplier: 'S',
              reverses_invoice_id: null,
              lines: [
                { card_handle, card_name, fmv_snapshot: 100, qty, unit_cost },
              ],
            },
            headers(),
          ),
        );

      it('returns the row, its associated packs and rank rewards, and stock movements newest first', async () => {
        const HANDLE = 'detail-card';
        await makeProduct(HANDLE, 'Detail Card', {
          options: [{ title: 'Format', values: ['Slab'] }],
          variants: [
            { title: 'Slab', sku: 'DETAIL-SKU-1', options: { Format: 'Slab' } },
          ],
        });
        await packs.createCards([
          {
            handle: HANDLE,
            name: 'Detail Card',
            set: 'Base',
            grader: 'PSA',
            grade: '10',
            market_value: 100, // USD -- the only USD in the system
            image: 'https://example.test/a.png',
          },
        ]);
        // A REAL Pack whose title DIFFERS from its slug. With title === slug
        // the listPacks lookup could be deleted outright and the assertion
        // below would still pass on the "?? slug" fallback.
        await packs.createPacks([
          {
            slug: 'detail-pack',
            title: 'Detail Pack',
            category: 'pokemon',
            price: 10,
            image: '/cdn/test-pack.webp',
            buyback_percent: 90,
          },
        ]);
        await packs.createPackOdds([
          {
            pack_id: 'detail-pack',
            card_id: HANDLE,
            rarity: 'Rare' as const,
            weight: 100,
            locked: false,
          },
          // A reward-pool entry must never surface as an association. NOTE:
          // this fixture does NOT discriminate the route's "kind: null" clause
          // -- the entry is already excluded by "card_id: handle", and the
          // pack_odds_kind_payout_check CHECK makes a kind-bearing row with a
          // card_id unrepresentable, so no fixture could discriminate it.
          {
            pack_id: 'reward-pack',
            kind: 'credit' as const,
            credit_amount: 5,
            weight: 1,
          },
        ]);
        // Same json double-cast the production writer uses (service.ts:5122):
        // rank_rewards is model.json(), typed Record<string, unknown>.
        const stage = (stage_number: number, rewards: unknown[]) => ({
          stage_number,
          threshold_myr: 100 * stage_number,
          rank_rewards: rewards as unknown as Record<string, unknown>,
        });
        await packs.createChallengeStages([
          stage(1, [
            { rank: 3, card_id: HANDLE, credits: 0 },
            // Neither of these may appear: a null card_id and another card.
            { rank: 1, card_id: null, credits: 5 },
          ]),
          stage(2, [{ rank: 1, card_id: 'some-other-card', credits: 0 }]),
        ]);

        // TWO invoices, as TWO separate requests, so created_at genuinely
        // differs -- rows written inside one transaction can share it to the
        // microsecond, which makes a "newest first" assertion flaky rather
        // than failing. 3 @ 30 then 2 @ 45 also makes cost a real WEIGHTED
        // average: 36, distinct from the plain mean 37.5, the first cost 30
        // and the last cost 45.
        expect((await buy(HANDLE, 'Detail Card', 3, 30)).status).toBe(201);
        expect((await buy(HANDLE, 'Detail Card', 2, 45)).status).toBe(201);

        const res = await getDetail(HANDLE);
        expect(res.status).toBe(200);
        // item is a full InventoryRow, not a stub: sku comes off the variant,
        // and 100 USD at the pinned 4.5 is RM 450, with the card's default 1.2
        // multiplier taking price to 540.
        expect(res.data.item.handle).toBe(HANDLE);
        expect(res.data.item.sku).toBe('DETAIL-SKU-1');
        expect(res.data.item.fmv).toBe(450);
        expect(res.data.item.price).toBe(540);
        expect(res.data.item.cost).toBe(36);

        expect(res.data.associated.packs).toEqual([
          { slug: 'detail-pack', title: 'Detail Pack' },
        ]);
        expect(res.data.associated.rank_rewards).toEqual([
          { stage_number: 1, rank: 3 },
        ]);

        expect(res.data.movements.total).toBe(2);
        expect(res.data.movements.rows).toHaveLength(2);
        // Newest first: the SECOND invoice (qty 2) leads.
        expect(res.data.movements.rows[0]).toMatchObject({
          kind: 'purchase',
          qty: 2,
        });
        expect(res.data.movements.rows[1]).toMatchObject({
          kind: 'purchase',
          qty: 3,
        });
        expect(res.data.movements.rows[0].ref_id).toBeTruthy();
        expect(res.data.movements.rows[0].ref_id).not.toBe(
          res.data.movements.rows[1].ref_id,
        );

        // total is a COUNT, not rows.length, and skip + order are both live:
        // page 2 of a 1-row page must be the OLDER movement.
        const paged = await getDetail(HANDLE, '?limit=1&offset=1');
        expect(paged.status).toBe(200);
        expect(paged.data.movements.total).toBe(2);
        expect(paged.data.movements.limit).toBe(1);
        expect(paged.data.movements.offset).toBe(1);
        expect(paged.data.movements.rows).toHaveLength(1);
        expect(paged.data.movements.rows[0].qty).toBe(3);
      });

      it('404s on an unknown handle and names it in the message', async () => {
        const res = await getDetail('does-not-exist');
        expect(res.status).toBe(404);
        // The status ALONE is vacuous -- an unrouted path 404s too, so this
        // assertion would pass with the route file deleted. Task 4 established
        // that an unrouted Medusa 404 carries NO message field at all, so
        // pinning the message (with the handle inside it) is what proves this
        // handler ran, and pinning the handle stops a future generic
        // error-shaping middleware from re-vacuuming it.
        expect(res.data.message).toMatch(
          /inventory item 'does-not-exist' not found/i,
        );

        // Pagination is parsed BEFORE the handle lookup, so malformed paging
        // is a 400 even on a handle that does not exist. Pinning it on the
        // UNKNOWN handle is what makes this discriminate: move the parse below
        // the .find() and this flips to 404.
        const badLimit = await getDetail('does-not-exist', '?limit=0');
        expect(badLimit.status).toBe(400);
      });

      it('keeps 0 distinct from null on cost and on_hand', async () => {
        // FREE STOCK. unit_cost 0 is legal (validate.ts rejects only n < 0)
        // and weightedAverageCost guards costScaledSum < 0, not <= 0, so a
        // genuinely free purchase returns 0 rather than null. The product is
        // UNTRACKED, so the invoice's best-effort inventory adjustment is a
        // no-op and on_hand stays null.
        const FREE = 'detail-free';
        await makeProduct(FREE, 'Detail Free');
        expect((await buy(FREE, 'Detail Free', 1, 0)).status).toBe(201);

        // TRACKED AT ZERO. All four pieces are required -- a manage_inventory
        // variant, a stock location, an inventory item, a level -- PLUS the
        // link wiring the variant to the item; without the link
        // getCardStockByHandle sees nothing and reports null.
        const TRACKED = 'detail-tracked';
        const tracked = await makeProduct(TRACKED, 'Detail Tracked', {
          options: [{ title: 'Format', values: ['Slab'] }],
          variants: [
            {
              title: 'Slab',
              sku: 'DETAIL-TRACKED',
              manage_inventory: true,
              options: { Format: 'Slab' },
            },
          ],
        });
        const stockLocationModule = getContainer().resolve(
          Modules.STOCK_LOCATION,
        );
        const location = await stockLocationModule.createStockLocations({
          name: 'Detail Warehouse',
        });
        const inventoryModule = getContainer().resolve(Modules.INVENTORY);
        const item = await inventoryModule.createInventoryItems({
          sku: 'DETAIL-TRACKED',
        });
        await inventoryModule.createInventoryLevels([
          {
            inventory_item_id: item.id,
            location_id: location.id,
            stocked_quantity: 0,
          },
        ]);
        const link = getContainer().resolve(ContainerRegistrationKeys.LINK);
        await link.create({
          [Modules.PRODUCT]: { variant_id: tracked.variants[0].id },
          [Modules.INVENTORY]: { inventory_item_id: item.id },
        });

        const free = (await getDetail(FREE)).data.item;
        const trackedRow = (await getDetail(TRACKED)).data.item;

        // toBe(0), NEVER toBeFalsy -- distinguishing 0 from null IS the
        // assertion. cost 0 = "bought, and free"; cost null = "no purchase
        // history". The two handles cover the pair crosswise, so the
        // "?? null" -> "|| null" mutation is caught on either field.
        expect(free.cost).toBe(0);
        expect(trackedRow.cost).toBeNull();
        // on_hand 0 = "tracked, nothing shippable"; null = untracked, i.e. the
        // product does not count units at all.
        expect(trackedRow.on_hand).toBe(0);
        expect(free.on_hand).toBeNull();
      });

      it('reads a blank metadata fmv as no FMV rather than as free', async () => {
        // An empty string is NOT nullish, so a "?? NaN" guard lets it through
        // and Number('') is 0 -- the row would render RM 0.00 for a field the
        // operator never filled in. Latent but reachable: no admin UI writes
        // product metadata, but a raw POST /admin/products/:id does.
        await makeProduct('detail-blank-fmv', 'Detail Blank Fmv', {
          metadata: { fmv: '' },
        });
        await makeProduct('detail-real-fmv', 'Detail Real Fmv', {
          metadata: { fmv: 20 },
        });

        const blank = (await getDetail('detail-blank-fmv')).data.item;
        expect(blank.fmv).toBeNull();
        expect(blank.price).toBeNull();

        // POSITIVE CONTROL: the metadata path is genuinely wired, so the nulls
        // above are the blank being rejected and not a dead reader. 20 USD at
        // 4.5 is RM 90, and with no Card row there is no multiplier, so
        // fmv === price.
        const real = (await getDetail('detail-real-fmv')).data.item;
        expect(real.fmv).toBe(90);
        expect(real.price).toBe(90);
      });
    });
  },
});
