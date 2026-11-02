import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'track-test-password-1';
const PACK_SLUG = 'track-pack';
const CARD_HANDLE = 'track-card';
const PACK_PRICE = 5;
const DELIVERED_NO = 'NVMYNINJA000000001';
const RETURNED_NO = 'NVMYNINJA000000002';
// Set just before each run: the tracker refuses a delivery dated before the order.
let DELIVERED_AT = '';

// The carrier side is faked at global fetch (the tracker's default fetchFn).
// Everything else is real: the migration's tracking_snapshot column, the
// workflow that completes the order, the pull flip and the audit row.
const ninjaAnswer = (no: string) =>
  no === DELIVERED_NO
    ? {
        status: 'Completed',
        granular_status: 'Completed',
        events: [
          {
            type: 'DELIVERY_SUCCESS',
            time: DELIVERED_AT,
            data: { is_rts: false },
          },
        ],
      }
    : {
        status: 'Completed',
        granular_status: 'Returned to Sender',
        events: [
          {
            type: 'DELIVERY_SUCCESS',
            time: DELIVERED_AT,
            data: { is_rts: true },
          },
        ],
      };

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('shipment tracker', () => {
      let storeHeaders: Record<string, string>;
      const realFetch = globalThis.fetch;

      beforeEach(async () => {
        jest
          .spyOn(globalThis, 'fetch')
          .mockImplementation(async (input, init) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.includes('api.ninjavan.co')) {
              const no = new URL(url).searchParams.get('tracking_id') ?? '';
              return new Response(JSON.stringify(ninjaAnswer(no)), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              });
            }
            return realFetch(input, init);
          });

        const container = getContainer();
        const key = await container.resolve(Modules.API_KEY).createApiKeys({
          title: 'track-test',
          type: 'publishable',
          created_by: 'track-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'Track Test Pack',
            category: 'pokemon',
            price: PACK_PRICE,
            image: '/cdn/test-pack.webp',
            buyback_percent: 90,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'Track Test Card',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: 25,
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
        await packs.createFxRates([
          { pair: 'USD_MYR', rate: 4, source: 'test', manual_override: false },
        ]);
      });

      afterEach(() => jest.restoreAllMocks());

      const authed = (token: string) => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });
      const post = (path: string, headers: Record<string, string>, body = {}) =>
        unwrapResponse(api.post(path, body, { headers }));

      // A customer with one shipped order carrying `trackingNo`.
      const shippedOrder = async (
        email: string,
        trackingNo: string,
        adminHeaders: Record<string, string>,
      ): Promise<{ orderId: string; pullId: string }> => {
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
        const token = (
          await api.post('/auth/customer/emailpass', {
            email,
            password: PASSWORD,
          })
        ).data.token as string;
        // RM25 covers the RM5 pack and the RM15 West shipping fee.
        await api.post(
          '/store/credits/topup',
          { amount: 25 },
          {
            headers: { ...authed(token), 'idempotency-key': `topup-${email}` },
          },
        );
        const pullId = (
          await post(`/store/packs/${PACK_SLUG}/open`, authed(token))
        ).data.pull.id as string;
        const addr = await api.post(
          '/store/customers/me/addresses',
          {
            first_name: 'Ada',
            last_name: 'Lovelace',
            address_1: '1 Analytical Way',
            city: 'Kuala Lumpur',
            postal_code: '50000',
            country_code: 'my',
          },
          { headers: authed(token) },
        );
        const addresses = addr.data.customer.addresses;
        const created = await post('/store/delivery-orders', authed(token), {
          pull_ids: [pullId],
          address_id: addresses[addresses.length - 1].id,
        });
        expect(created.status).toBe(201);
        const orderId = created.data.order_id as string;
        for (const body of [
          { status: 'processed' },
          { status: 'ready_to_ship' },
          { status: 'shipped', tracking_number: trackingNo },
        ]) {
          expect(
            (
              await post(
                `/admin/delivery-orders/${orderId}`,
                adminHeaders,
                body,
              )
            ).status,
          ).toBe(200);
        }
        return { orderId, pullId };
      };

      it('completes the delivered parcel at the carrier time and only flags the returned one', async () => {
        const adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'track-admin@test.dev',
          'admin-pass-1',
        );
        const adminHeaders = { authorization: `Bearer ${adminToken}` };
        const delivered = await shippedOrder(
          'track-a@test.dev',
          DELIVERED_NO,
          adminHeaders,
        );
        const returned = await shippedOrder(
          'track-b@test.dev',
          RETURNED_NO,
          adminHeaders,
        );

        DELIVERED_AT = new Date().toISOString();
        const run = await post('/admin/delivery-orders/track', adminHeaders);
        expect(run.status).toBe(200);
        expect(run.data).toEqual({
          checked: 2,
          completed: [delivered.orderId],
          problems: [returned.orderId],
          failed: [],
        });

        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [done] = await packs.listDeliveryOrders(
          { id: delivered.orderId },
          { take: 1 },
        );
        expect(done.status).toBe('completed');
        expect(new Date(done.delivered_at as Date).toISOString()).toBe(
          new Date(DELIVERED_AT).toISOString(),
        );
        const [pull] = await packs.listPulls(
          { id: delivered.pullId },
          { take: 1 },
        );
        expect(pull.status).toBe('delivered');
        const audits = await packs.listAdminActionAudits(
          { entity_type: 'delivery_order', entity_id: delivered.orderId },
          { take: 20, order: { created_at: 'ASC', id: 'ASC' } },
        );
        const last = audits[audits.length - 1];
        expect(last.admin_id).toBe('system:shipment-tracker');
        expect(last.after).toEqual({ status: 'completed' });
        expect(last.reason).toContain(`Ninja Van reports ${DELIVERED_NO}`);

        // The returned parcel stays shipped, its cards still on the way.
        const [held] = await packs.listDeliveryOrders(
          { id: returned.orderId },
          { take: 1 },
        );
        expect(held.status).toBe('shipped');
        const [heldPull] = await packs.listPulls(
          { id: returned.pullId },
          { take: 1 },
        );
        expect(heldPull.status).toBe('delivering');

        // The admin list carries the snapshot; the store list does not.
        const list = await unwrapResponse(
          api.get('/admin/delivery-orders?status=shipped', {
            headers: adminHeaders,
          }),
        );
        const row = list.data.orders.find(
          (o: { id: string }) => o.id === returned.orderId,
        );
        expect(row.tracking_snapshot).toMatchObject({
          tracking_number: RETURNED_NO,
          carrier: 'ninjavan',
          state: 'problem',
          event: 'Returned to Sender',
        });

        // A second run finds nothing left to complete.
        const again = await post('/admin/delivery-orders/track', adminHeaders);
        expect(again.data.completed).toEqual([]);
      });
    });
  },
});
