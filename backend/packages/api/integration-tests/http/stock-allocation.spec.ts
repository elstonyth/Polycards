import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules, ProductStatus } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { runStockAllocation } from '../../src/modules/packs/stock-allocation-run';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'stock-alloc-test-pw-1'; // gitleaks:allow
const ADMIN_EMAIL = 'stock-alloc-admin@test.dev';

const ADDRESS = {
  ship_name: 'Ada',
  ship_address_1: '1 Way',
  ship_address_2: null,
  ship_city: 'KL',
  ship_province: null,
  ship_postal_code: '50000',
  ship_country_code: 'my',
  ship_phone: null,
};

// Orders move by themselves (spec 2026-10-28): a GRN save completes the
// oldest waiting order first, the nightly run moves the rest to processed,
// and two runs at once never move one order twice.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('stock allocation', () => {
      let token: string;
      let packs: PacksModuleService;
      const headers = () => ({
        headers: { authorization: `Bearer ${token}` },
      });

      beforeEach(async () => {
        packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        token = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
      });

      const makeProduct = (handle: string) =>
        getContainer()
          .resolve(Modules.PRODUCT)
          .createProducts([
            { title: handle, handle, status: ProductStatus.PUBLISHED },
          ]);

      // A requested order holding one 'delivering' pull per handle — the
      // state both request paths leave behind.
      const requestOrder = async (customer: string, handles: string[]) => {
        const [order] = await packs.createDeliveryOrders([
          { customer_id: customer, status: 'requested', ...ADDRESS },
        ]);
        for (const handle of handles) {
          const [pull] = await packs.createPulls([
            {
              customer_id: customer,
              pack_id: 'alloc-pack',
              card_id: handle,
              rolled_at: new Date(),
              status: 'delivering' as const,
              source: 'pack' as const,
            },
          ]);
          await packs.createDeliveryOrderItems([
            { delivery_order_id: order.id, pull_id: pull.id },
          ]);
        }
        // Distinct created_at, so "oldest" is never a tie.
        await new Promise((r) => setTimeout(r, 25));
        return order.id;
      };

      const statusOf = async (id: string) =>
        (await packs.listDeliveryOrders({ id }, { take: 1 }))[0].status;

      const receive = (handle: string, qty: number) =>
        unwrapResponse(
          api.post(
            '/admin/goods-receive-notes',
            {
              date: '2026-10-28T00:00:00.000Z',
              supplier: 'S',
              lines: [
                {
                  card_handle: handle,
                  card_name: handle,
                  fmv_snapshot: 10,
                  qty,
                },
              ],
            },
            headers(),
          ),
        );

      it('a GRN completes the oldest order first; the nightly run moves the rest to processed', async () => {
        await makeProduct('alloc-card');
        const older = await requestOrder('cus_old', ['alloc-card']);
        const newer = await requestOrder('cus_new', ['alloc-card']);

        expect((await receive('alloc-card', 1)).status).toBe(201);
        expect(await statusOf(older)).toBe('ready_to_ship');
        expect(await statusOf(newer)).toBe('requested');

        const nightly = await runStockAllocation(getContainer(), {
          nightly: true,
        });
        expect(nightly).toEqual({ ready: [], processed: [newer], failed: [] });
        expect(await statusOf(newer)).toBe('processed');

        // Both automatic moves are audited against the system actor.
        const audits = await packs.listAdminActionAudits(
          { admin_id: 'system:stock-allocation', entity_id: [older, newer] },
          { take: 10 },
        );
        expect(audits.length).toBe(3); // older: 2 hops, newer: 1
      });

      it('an older order short of one card holds its unit; a newer order for another card still ships', async () => {
        await makeProduct('alloc-a');
        await makeProduct('alloc-b');
        await makeProduct('alloc-c');
        const older = await requestOrder('cus_1', ['alloc-a', 'alloc-b']);
        const sameCard = await requestOrder('cus_2', ['alloc-a']);
        const otherCard = await requestOrder('cus_3', ['alloc-c']);

        await receive('alloc-a', 1);
        await receive('alloc-c', 1);
        expect(await statusOf(older)).toBe('requested');
        expect(await statusOf(sameCard)).toBe('requested');
        expect(await statusOf(otherCard)).toBe('ready_to_ship');

        const list = (
          await unwrapResponse(api.get('/admin/inventory?q=alloc-', headers()))
        ).data.rows as Array<{ handle: string; to_procure: number }>;
        const need = (h: string) =>
          list.find((r) => r.handle === h)!.to_procure;
        expect(need('alloc-a')).toBe(1); // 2 wanted, 1 on hand
        expect(need('alloc-b')).toBe(1);
        expect(need('alloc-c')).toBe(0);
      });

      it('two runs at once never move one order twice and never throw', async () => {
        await makeProduct('alloc-race');
        const order = await requestOrder('cus_race', ['alloc-race']);
        await packs.createGoodsReceiveNoteWithLines({
          date: '2026-10-28T00:00:00.000Z',
          supplier: 'S',
          agent_user_id: 'user_test',
          reverses_grn_id: null,
          lines: [
            {
              card_handle: 'alloc-race',
              card_name: 'alloc-race',
              fmv_snapshot: 10,
              qty: 1,
            },
          ],
        });

        const [a, b] = await Promise.all([
          runStockAllocation(getContainer(), { nightly: false }),
          runStockAllocation(getContainer(), { nightly: false }),
        ]);
        expect(await statusOf(order)).toBe('ready_to_ship');
        // Exactly one run made the final move; the other either found it
        // already moved or lost the race cleanly.
        expect(
          [...a.ready, ...b.ready].filter((id) => id === order),
        ).toHaveLength(1);
      });
    });
  },
});
