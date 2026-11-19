import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import {
  SHIP_PILE_UNCHECKED_REFUSAL,
  type DeliveryStatus,
} from '../../src/modules/packs/delivery';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'ship-pile-test-pw-1'; // gitleaks:allow
const ADMIN_EMAIL = 'ship-pile-admin@test.dev';

// Orders are seeded straight through the module service with no pulls or
// items, as delivery-orders-bulk.spec.ts does: the ship-pile guard reads only
// the order row and the audit rows, and the cancel's money and stock reversal
// has its own specs (ledger-delivery.spec.ts, delivery-transition-atomic).
const ADDRESS = {
  ship_name: 'Ali Bin Abu',
  ship_address_1: '1 Jalan Test',
  ship_address_2: null,
  ship_city: 'Ipoh',
  ship_province: null,
  ship_postal_code: '30000',
  ship_country_code: 'my',
  ship_phone: null,
};

// Incident 2026-11-03: an order cancelled from ready_to_ship went
// out anyway because nobody told the packer. This pins both guards against a
// real database: the cancel refuses without the pile check, and every cancel
// from the pile sits on GET /admin/delivery-orders/ship-pile until the packer
// marks the parcel pulled.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('admin delivery-orders ship pile', () => {
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
      });

      const headers = () => ({
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const post = (path: string, body: unknown) =>
        unwrapResponse(api.post(path, body, headers()));
      const get = (path: string) => unwrapResponse(api.get(path, headers()));

      const seedOrder = async (
        customerId: string,
        status: DeliveryStatus,
      ): Promise<string> => {
        const [order] = await packs.createDeliveryOrders([
          { customer_id: customerId, status, ...ADDRESS },
        ]);
        return order.id as string;
      };
      const statusOf = async (id: string) =>
        (await packs.listDeliveryOrders({ id }, { take: 1 }))[0].status;
      const auditsFor = (id: string) =>
        packs.listAdminActionAudits(
          { entity_type: 'delivery_order', entity_id: id },
          { take: 10, order: { created_at: 'ASC' } },
        );

      it('refuses an unchecked cancel from the pile, then lets a checked one through', async () => {
        const id = await seedOrder('cus_pile_a', 'ready_to_ship');

        const refused = await post(`/admin/delivery-orders/${id}`, {
          status: 'canceled',
        });
        expect(refused.status).toBe(400);
        expect(refused.data.message).toBe(SHIP_PILE_UNCHECKED_REFUSAL);
        expect(await statusOf(id)).toBe('ready_to_ship');
        expect(await auditsFor(id)).toHaveLength(0);

        const ok = await post(`/admin/delivery-orders/${id}`, {
          status: 'canceled',
          pile_checked: true,
        });
        expect(ok.status).toBe(200);
        expect(await statusOf(id)).toBe('canceled');
        const [audit] = await auditsFor(id);
        expect(audit).toMatchObject({
          before: { status: 'ready_to_ship' },
          after: { status: 'canceled' },
        });
      });

      it('cancels before the pile with no check, and lists nothing for it', async () => {
        const id = await seedOrder('cus_pile_b', 'processed');
        const ok = await post(`/admin/delivery-orders/${id}`, {
          status: 'canceled',
        });
        expect(ok.status).toBe(200);

        const pile = await get('/admin/delivery-orders/ship-pile');
        expect(pile.status).toBe(200);
        expect(pile.data.open).toEqual([]);

        const cleared = await post(
          `/admin/delivery-orders/${id}/ship-pile`,
          {},
        );
        expect(cleared.status).toBe(400);
        expect(cleared.data.message).toMatch(/has not left the ship pile/);
      });

      it('lists a cancel from the pile until the parcel is marked pulled, once', async () => {
        const id = await seedOrder('cus_pile_c', 'pending_ship');
        await post(`/admin/delivery-orders/${id}`, {
          status: 'canceled',
          pile_checked: true,
        });

        const pile = await get('/admin/delivery-orders/ship-pile');
        expect(pile.status).toBe(200);
        expect(pile.data.open).toEqual([
          expect.objectContaining({
            order_id: id,
            from_status: 'pending_ship',
            to_status: 'canceled',
            ship_name: 'Ali Bin Abu',
            ship_city: 'Ipoh',
            moved_by: ADMIN_EMAIL,
          }),
        ]);
        expect(pile.data.truncated).toBe(false);
        // No player email or staff reason on the packer's list.
        expect(pile.data.open[0]).not.toHaveProperty('customer_email');
        expect(pile.data.open[0]).not.toHaveProperty('reason');

        // The Orders table marks the row too, still open.
        const list = await get('/admin/delivery-orders?status=canceled');
        const row = list.data.orders.find((o: { id: string }) => o.id === id);
        expect(row.ship_pile).toMatchObject({
          from_status: 'pending_ship',
          to_status: 'canceled',
          cleared_at: null,
        });

        const first = await post(`/admin/delivery-orders/${id}/ship-pile`, {});
        expect(first.status).toBe(200);
        expect(first.data).toMatchObject({
          order_id: id,
          already_cleared: false,
        });

        const after = await get('/admin/delivery-orders/ship-pile');
        expect(after.data.open).toEqual([]);
        const relisted = await get('/admin/delivery-orders?status=canceled');
        const cleared = relisted.data.orders.find(
          (o: { id: string }) => o.id === id,
        );
        expect(cleared.ship_pile.cleared_at).not.toBeNull();

        // A second press writes nothing more.
        const second = await post(`/admin/delivery-orders/${id}/ship-pile`, {});
        expect(second.status).toBe(200);
        expect(second.data.already_cleared).toBe(true);
        const audits = await auditsFor(id);
        expect(audits).toHaveLength(2);
        expect(audits[1]).toMatchObject({
          action: 'edit',
          before: { ship_pile: 'open' },
          after: { ship_pile: 'cleared' },
        });

        // The order itself is untouched by the mark.
        expect(await statusOf(id)).toBe('canceled');
      });

      it('checks only the ids the admin confirmed in a bulk cancel', async () => {
        const early = await seedOrder('cus_pile_d', 'requested');
        const packed = await seedOrder('cus_pile_e', 'ready_to_ship');
        // Entered the pile after the admin's page loaded: never confirmed.
        const late = await seedOrder('cus_pile_g', 'ready_to_ship');

        const unchecked = await post('/admin/delivery-orders/bulk', {
          ids: [early, packed],
          status: 'canceled',
        });
        expect(unchecked.status).toBe(200);
        expect(unchecked.data.updated).toEqual([early]);
        expect(unchecked.data.skipped).toEqual([
          { id: packed, reason: SHIP_PILE_UNCHECKED_REFUSAL },
        ]);
        expect(await statusOf(packed)).toBe('ready_to_ship');

        const checked = await post('/admin/delivery-orders/bulk', {
          ids: [packed, late],
          status: 'canceled',
          pile_checked_ids: [packed],
        });
        expect(checked.data.updated).toEqual([packed]);
        expect(checked.data.skipped).toEqual([
          { id: late, reason: SHIP_PILE_UNCHECKED_REFUSAL },
        ]);
        expect(await statusOf(late)).toBe('ready_to_ship');

        const pile = await get('/admin/delivery-orders/ship-pile');
        expect(
          pile.data.open.map((e: { order_id: string }) => e.order_id),
        ).toEqual([packed]);
      });

      it('guards and lists a step back to processed like a cancel', async () => {
        const id = await seedOrder('cus_pile_h', 'ready_to_ship');

        const refused = await post(`/admin/delivery-orders/${id}`, {
          status: 'processed',
        });
        expect(refused.status).toBe(400);
        expect(refused.data.message).toBe(SHIP_PILE_UNCHECKED_REFUSAL);

        const back = await post(`/admin/delivery-orders/${id}`, {
          status: 'processed',
          pile_checked: true,
        });
        expect(back.status).toBe(200);
        // The later cancel from processed asks nothing, but the step back
        // already put the order on the packer's list.
        const cancel = await post(`/admin/delivery-orders/${id}`, {
          status: 'canceled',
        });
        expect(cancel.status).toBe(200);

        const pile = await get('/admin/delivery-orders/ship-pile');
        expect(pile.data.open).toEqual([
          expect.objectContaining({
            order_id: id,
            from_status: 'ready_to_ship',
            to_status: 'processed',
          }),
        ]);

        const cleared = await post(
          `/admin/delivery-orders/${id}/ship-pile`,
          {},
        );
        expect(cleared.data.already_cleared).toBe(false);
        expect(
          (await get('/admin/delivery-orders/ship-pile')).data.open,
        ).toEqual([]);
      });

      it('404s the mark for an unknown order', async () => {
        const res = await post(
          '/admin/delivery-orders/do_does_not_exist/ship-pile',
          {},
        );
        expect(res.status).toBe(404);
      });

      it('refuses a non-boolean pile_checked', async () => {
        const id = await seedOrder('cus_pile_f', 'ready_to_ship');
        const res = await post(`/admin/delivery-orders/${id}`, {
          status: 'canceled',
          pile_checked: 'yes',
        });
        expect(res.status).toBe(400);
        expect(await statusOf(id)).toBe('ready_to_ship');
      });
    });
  },
});
