import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules, ProductStatus } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { clearFxDisplayCache } from '../../src/modules/packs/pricing';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'inventory-list-test-pw-1'; // gitleaks:allow
const ADMIN_EMAIL = 'inventory-list-admin@test.dev';

const FX = 4.5;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET /admin/inventory', () => {
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
        // A fresh test DB has NO fx_rate row, so both the strict resolver
        // (purchase-invoice create) and the display one would fall back to
        // DEFAULT_USD_MYR. Pin a firm rate before any other call.
        await unwrapResponse(
          api.post(
            '/admin/pricing/fx',
            { manual_override: true, manual_rate: FX, reason: 'pin for test' },
            { headers: { authorization: `Bearer ${adminToken}` } },
          ),
        );
        // The FX ROUTE does not evict the display cache (grep: no
        // clearFxDisplayCache call in api/admin/pricing/fx/route.ts), and that
        // cache is module state living 30s across tests while the runner
        // truncates the DB between them. Without this, a later test's fmv/price
        // assertions can pass on the PREVIOUS test's rate.
        clearFxDisplayCache();
      });

      const headers = () => ({
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const rowsOf = async (qs = '') => {
        const res = await unwrapResponse(
          api.get(`/admin/inventory${qs}`, headers()),
        );
        expect(res.status).toBe(200);
        return res.data.rows as Array<Record<string, unknown>>;
      };

      const rowFor = (rows: Array<Record<string, unknown>>, handle: string) =>
        rows.find((r) => r.handle === handle);

      it('lists a registered card with its buckets, weighted-average cost and MYR prices', async () => {
        const HANDLE = 'inv-list-card';
        const productModule = getContainer().resolve(Modules.PRODUCT);

        // The list's grain is PRODUCTS — a Card with no Product counterpart is
        // NOT a row. The variant carries the SKU (Card has no sku column).
        await productModule.createProducts([
          {
            title: 'Inv List Card',
            handle: HANDLE,
            status: ProductStatus.PUBLISHED,
            options: [{ title: 'Format', values: ['Slab'] }],
            variants: [
              { title: 'Slab', sku: 'INV-SKU-1', options: { Format: 'Slab' } },
            ],
          },
        ]);
        await packs.createCards([
          {
            handle: HANDLE,
            name: 'Inv List Card',
            set: 'Base',
            grader: 'PSA',
            grade: '10',
            market_value: 100, // USD — the only USD in the system
            image: 'https://example.test/a.png',
          },
        ]);
        await packs.createPulls([
          {
            customer_id: 'cus_inv_list',
            pack_id: 'inv-list-pack',
            card_id: HANDLE,
            rolled_at: new Date(),
            status: 'vaulted' as const,
            source: 'pack' as const,
          },
        ]);
        const purchase = await unwrapResponse(
          api.post(
            '/admin/purchase-invoices',
            {
              date: '2026-07-28T00:00:00.000Z',
              supplier: 'S',
              reverses_invoice_id: null,
              lines: [
                {
                  card_handle: HANDLE,
                  card_name: 'Inv List Card',
                  fmv_snapshot: 450,
                  qty: 4,
                  unit_cost: 40,
                },
              ],
            },
            headers(),
          ),
        );
        expect(purchase.status).toBe(201);

        const row = rowFor(await rowsOf(), HANDLE);
        expect(row).toBeTruthy();
        expect(row!.is_card).toBe(true);
        expect(row!.name).toBe('Inv List Card');
        expect(row!.sku).toBe('INV-SKU-1');
        expect(row!.graded).toBe(true);
        expect(row!.cost).toBe(40); // D8 weighted average, 4 @ 40
        expect(row!.in_vault).toBe(1);
        expect(row!.requested).toBe(0);
        expect(row!.shipped).toBe(0);
        expect(row!.listing_count).toBe(0); // in no pack pool, no rank reward
        // The money leg the bucket spec never touched: 100 USD at the pinned
        // 4.5 is RM 450, and `price` must ALSO carry the card's multiplier
        // (Card.market_multiplier defaults to DEFAULT_MARKET_MULTIPLIER = 1.2).
        // 540 is the only value that discriminates the multiplier wiring —
        // fmv === price would mean the mult argument never arrived.
        expect(row!.fmv).toBe(450);
        expect(row!.price).toBe(540);
      });

      it('q narrows the list to matching products, and a product with no Card row still renders', async () => {
        const productModule = getContainer().resolve(Modules.PRODUCT);
        await productModule.createProducts([
          {
            title: 'Zzyzx Eligible Product',
            handle: 'zzyzx-eligible',
            status: ProductStatus.DRAFT,
            metadata: { fmv: 77, grade: 'PSA 9', grader: 'PSA' },
          },
          {
            title: 'Qqq Excluded Product',
            handle: 'qqq-excluded',
            status: ProductStatus.DRAFT,
            metadata: {},
          },
        ]);

        // Unfiltered first: proves BOTH fixtures exist, so the ?q= absence
        // below is the filter working and not a product that was never created.
        const all = await rowsOf();
        const zzyzxAll = rowFor(all, 'zzyzx-eligible');
        const qqq = rowFor(all, 'qqq-excluded');
        expect(zzyzxAll).toBeTruthy();
        expect(qqq).toBeTruthy();
        // No Card row and no metadata.fmv: fmv/price/cost must be null, NEVER
        // 0 — Number(null) is 0, and "no FMV recorded" is not "free".
        expect(qqq!.is_card).toBe(false);
        expect(qqq!.fmv).toBeNull();
        expect(qqq!.price).toBeNull();
        expect(qqq!.cost).toBeNull();
        expect(qqq!.graded).toBe(false);

        const filtered = await rowsOf('?q=Zzyzx');
        const zzyzx = rowFor(filtered, 'zzyzx-eligible');
        expect(zzyzx).toBeTruthy();
        expect(rowFor(filtered, 'qqq-excluded')).toBeUndefined();
        expect(zzyzx!.is_card).toBe(false);
        // RAW/GRADED works pre-Card: the grader comes off product.metadata.
        expect(zzyzx!.graded).toBe(true);
        expect(zzyzx!.name).toBe('Zzyzx Eligible Product');
        expect(zzyzx!.sku).toBe('zzyzx-eligible'); // no variant -> handle
        // 77 USD x 4.5 x DEFAULT_MARKET_MULTIPLIER 1.2: a non-card row prices
        // at the default margin (matches the from-PC importer's listing price).
        expect(zzyzx!.fmv).toBe(346.5);
        expect(zzyzx!.price).toBe(415.8);

        // A search that matches NOTHING must render an empty list, not a 500.
        // handles === [] is a real hazard, not a formality: every aggregate
        // here builds an IN (...) list, and `IN ()` is a Postgres syntax
        // error - the length guards at the top of each are what keep this 200.
        expect(await rowsOf('?q=zzzz-matches-no-product')).toEqual([]);
      });
    });
  },
});
