import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import type { DeliveryStatus } from '../../src/modules/packs/delivery';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'bulk-delivery-test-pw-1';
const ADMIN_EMAIL = 'bulk-delivery-admin@test.dev';

// Address snapshot columns are NOT NULL — orders are seeded straight through
// the module service (no pulls, no items) because the bulk route only reads
// the order row and runs the transition; the full store flow would add
// minutes of setup for nothing this endpoint touches.
const ADDRESS = {
  ship_name: 'Ada Lovelace',
  ship_address_1: '1 Analytical Way',
  ship_address_2: null,
  ship_city: 'London',
  ship_province: null,
  ship_postal_code: 'EC1',
  ship_country_code: 'gb',
  ship_phone: null,
};

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('admin delivery-orders bulk + id search', () => {
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

      const adminHeaders = () => ({
        headers: { authorization: `Bearer ${adminToken}` },
      });

      const seedOrder = async (
        customerId: string,
        status: DeliveryStatus,
        tracking?: string,
      ): Promise<string> => {
        const [order] = await packs.createDeliveryOrders([
          {
            customer_id: customerId,
            status,
            tracking_number: tracking ?? null,
            ...ADDRESS,
          },
        ]);
        return order.id as string;
      };

      const statusOf = async (id: string): Promise<string> => {
        const [row] = await packs.listDeliveryOrders({ id }, { take: 1 });
        return row.status;
      };

      const auditsFor = async (id: string) =>
        packs.listAdminActionAudits(
          { entity_type: 'delivery_order', entity_id: id },
          { take: 10 },
        );

      const bulk = (body: unknown) =>
        unwrapResponse(
          api.post('/admin/delivery-orders/bulk', body, adminHeaders()),
        );

      it('marks two requested orders processed and writes one audit row each', async () => {
        const a = await seedOrder('cus_bulk_a', 'requested');
        const b = await seedOrder('cus_bulk_b', 'requested');

        const res = await bulk({ ids: [a, b], status: 'processed' });
        expect(res.status).toBe(200);
        expect(res.data.updated.sort()).toEqual([a, b].sort());
        expect(res.data.skipped).toEqual([]);

        expect(await statusOf(a)).toBe('processed');
        expect(await statusOf(b)).toBe('processed');

        for (const id of [a, b]) {
          const [audit] = await auditsFor(id);
          expect(audit).toMatchObject({
            entity_type: 'delivery_order',
            entity_id: id,
            action: 'bulk_status',
            before: { status: 'requested' },
            after: { status: 'processed' },
            reason: 'bulk mark as processed',
          });
          expect(typeof audit.admin_id).toBe('string');
          expect(audit.admin_id.length).toBeGreaterThan(0);
        }
      });

      it('skips an order that cannot legally reach the target status, and audits nothing for it', async () => {
        const requested = await seedOrder('cus_bulk_c', 'requested');
        // shipped → canceled is refused by validateDeliveryStatusTransition:
        // a parcel already in transit can't go back to the vault.
        const shipped = await seedOrder('cus_bulk_d', 'shipped', 'TRACK-BULK-1');

        const res = await bulk({ ids: [requested, shipped], status: 'canceled' });
        expect(res.status).toBe(200);
        expect(res.data.updated).toEqual([requested]);
        expect(res.data.skipped).toHaveLength(1);
        expect(res.data.skipped[0].id).toBe(shipped);
        expect(res.data.skipped[0].reason).toMatch(
          /cannot move|invalid|not allowed/i,
        );

        expect(await statusOf(requested)).toBe('canceled');
        expect(await statusOf(shipped)).toBe('shipped'); // untouched
        expect(await auditsFor(shipped)).toHaveLength(0);
        expect(await auditsFor(requested)).toHaveLength(1);
      });

      it('rejects a batch over the 100-id cap with 400', async () => {
        const res = await bulk({
          ids: Array.from({ length: 101 }, (_, i) => `do_${i}`),
          status: 'processed',
        });
        expect(res.status).toBe(400);
        expect(JSON.stringify(res.data)).toMatch(/100/);
      });

      it('?q= filters the list to the orders whose id contains the substring', async () => {
        const target = await seedOrder('cus_bulk_e', 'requested');
        const other = await seedOrder('cus_bulk_f', 'requested');
        const q = target.slice(-6);

        const res = await unwrapResponse(
          api.get(`/admin/delivery-orders?q=${q}`, adminHeaders()),
        );
        expect(res.status).toBe(200);
        expect(res.data.orders.map((o: { id: string }) => o.id)).toEqual([
          target,
        ]);
        expect(res.data.total).toBe(1);
        expect(res.data.orders[0].id).not.toBe(other);
      });

      it('rejects a ?q= longer than 64 characters with 400', async () => {
        const res = await unwrapResponse(
          api.get(`/admin/delivery-orders?q=${'x'.repeat(65)}`, adminHeaders()),
        );
        expect(res.status).toBe(400);
      });
    });
  },
});
