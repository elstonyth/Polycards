import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from '@medusajs/framework/utils';
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
        // The post-save run is off by default (stockAutoAllocationEnabled).
        process.env.STOCK_AUTO_ALLOCATION = 'true';
        packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        token = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        // A GRN save refuses without a firm FX rate (same gate as invoices).
        await unwrapResponse(
          api.post(
            '/admin/pricing/fx',
            { manual_override: true, manual_rate: 4.5, reason: 'pin for test' },
            headers(),
          ),
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

      it('keeps a tracking number staff already entered, and names the save in the audit reason', async () => {
        await makeProduct('alloc-track');
        const order = await requestOrder('cus_track', ['alloc-track']);
        await packs.updateDeliveryOrders([
          { id: order, status: 'processed', tracking_number: 'TRK-123' },
        ]);
        const saved = await receive('alloc-track', 1);
        expect(saved.status).toBe(201);
        const [row] = await packs.listDeliveryOrders(
          { id: order },
          { take: 1 },
        );
        expect(row.status).toBe('ready_to_ship');
        expect(row.tracking_number).toBe('TRK-123');
        const [audit] = await packs.listAdminActionAudits(
          { entity_id: order, admin_id: 'system:stock-allocation' },
          { take: 1 },
        );
        expect(audit.reason).toContain(
          `after ${saved.data.goods_receive_note.display_no} by `,
        );
      });

      it('moves nothing on save while STOCK_AUTO_ALLOCATION is off', async () => {
        process.env.STOCK_AUTO_ALLOCATION = 'false';
        await makeProduct('alloc-off');
        const order = await requestOrder('cus_off', ['alloc-off']);
        expect((await receive('alloc-off', 1)).status).toBe(201);
        expect(await statusOf(order)).toBe('requested');
      });

      it("moves a legacy 'packing' order to ready_to_ship through processed", async () => {
        await makeProduct('alloc-packing');
        const order = await requestOrder('cus_packing', ['alloc-packing']);
        // The model enum no longer lists 'packing'; the DB CHECK still allows
        // it (Migration20260727000000's expand phase), so seed it raw.
        await getContainer()
          .resolve(ContainerRegistrationKeys.PG_CONNECTION)
          .raw(`UPDATE delivery_order SET status = 'packing' WHERE id = ?`, [
            order,
          ]);
        expect((await receive('alloc-packing', 1)).status).toBe(201);
        expect(await statusOf(order)).toBe('ready_to_ship');
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

      it('to-buy lists short cards by oldest waiting order; to-ship lists ready orders oldest first', async () => {
        await makeProduct('buy-late');
        await makeProduct('buy-early');
        await makeProduct('ship-card');
        const first = await requestOrder('cus_p1', ['buy-early']);
        await requestOrder('cus_p2', ['buy-late', 'buy-late']);
        const shipOld = await requestOrder('cus_p3', ['ship-card']);
        const shipNew = await requestOrder('cus_p4', ['ship-card']);
        await receive('ship-card', 2);
        expect(await statusOf(shipOld)).toBe('ready_to_ship');
        expect(await statusOf(shipNew)).toBe('ready_to_ship');

        const toBuy = (
          await unwrapResponse(api.get('/admin/procurement/to-buy', headers()))
        ).data.rows as Array<{ handle: string; to_procure: number }>;
        expect(toBuy.map((r) => [r.handle, r.to_procure])).toEqual([
          ['buy-early', 1],
          ['buy-late', 2],
        ]);
        expect(await statusOf(first)).toBe('requested');

        const toShip = (
          await unwrapResponse(api.get('/admin/procurement/to-ship', headers()))
        ).data.orders as Array<{ id: string; items: unknown[] }>;
        expect(toShip.map((o) => o.id)).toEqual([shipOld, shipNew]);
        expect(toShip[0].items).toHaveLength(1);
      });
    });
  },
});
