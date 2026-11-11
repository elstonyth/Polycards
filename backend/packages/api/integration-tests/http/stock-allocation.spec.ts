import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import {
  ContainerRegistrationKeys,
  generateJwtToken,
  Modules,
  ProductStatus,
} from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { runStockAllocation } from '../../src/modules/packs/stock-allocation-run';
import { runMidnightCutoff } from '../../src/jobs/stock-allocation';
import {
  mintSuperAdmin,
  staffIdentityWithAuthenticator,
  unwrapResponse,
} from './utils';

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

// Orders move by themselves at the 12am cutoff (spec 2026-10-28; owner
// 2026-10-28): a GRN save moves nothing; the 00:00 job completes the oldest
// waiting order first, moves the rest to processed and freezes that day's
// to-buy list. Two runs at once never move one order twice. Staff can do the
// completing half earlier with the Stock page's Refresh (operator, 2026-11-03).
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
        // The 12am job is off by default (stockAutoAllocationEnabled).
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

      // now: the job's clock — a later night is simulated by passing one.
      const midnight = (now?: Date) => runMidnightCutoff(getContainer(), now);
      const nextNight = () => new Date(Date.now() + 24 * 3600 * 1000);

      it('a GRN save moves no order; the 12am run completes the oldest first and moves the rest to processed', async () => {
        await makeProduct('alloc-card');
        const older = await requestOrder('cus_old', ['alloc-card']);
        const newer = await requestOrder('cus_new', ['alloc-card']);

        expect((await receive('alloc-card', 1)).status).toBe(201);
        expect(await statusOf(older)).toBe('requested');
        expect(await statusOf(newer)).toBe('requested');

        await midnight();
        expect(await statusOf(older)).toBe('ready_to_ship');
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
        await midnight();
        expect(await statusOf(older)).toBe('processed');
        expect(await statusOf(sameCard)).toBe('processed');
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

      it('keeps a tracking number staff already entered, and names the 12am run in the audit reason', async () => {
        await makeProduct('alloc-track');
        const order = await requestOrder('cus_track', ['alloc-track']);
        await packs.updateDeliveryOrders([
          { id: order, status: 'processed', tracking_number: 'TRK-123' },
        ]);
        expect((await receive('alloc-track', 1)).status).toBe(201);
        await midnight();
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
        expect(audit.reason).toBe(
          'stock allocation (nightly): all cards on hand',
        );
      });

      it('runs once per day: a second run the same day moves nothing and keeps the list', async () => {
        await makeProduct('alloc-once');
        await midnight();
        const [first] = await packs.listProcurementSnapshots({}, { take: 5 });
        // Placed after 12am, fully stocked: it waits for the next night.
        const late = await requestOrder('cus_late', ['alloc-once']);
        await receive('alloc-once', 1);
        await midnight();
        expect(await statusOf(late)).toBe('requested');
        expect(
          (await packs.listProcurementSnapshots({}, { take: 5 })).map(
            (s) => s.id,
          ),
        ).toEqual([first.id]);
      });

      const pressRefresh = (requestHeaders = headers()) =>
        unwrapResponse(
          api.post('/admin/delivery-orders/allocate', {}, requestHeaders),
        );

      it('Refresh moves complete orders to ready_to_ship now, leaves short ones requested and freezes nothing', async () => {
        await makeProduct('alloc-now');
        await makeProduct('alloc-now-2');
        await makeProduct('alloc-short');
        const complete = await requestOrder('cus_now', ['alloc-now']);
        const inBuying = await requestOrder('cus_buying', ['alloc-now-2']);
        await packs.updateDeliveryOrders([
          { id: inBuying, status: 'processed' },
        ]);
        const short = await requestOrder('cus_short', ['alloc-short']);
        await receive('alloc-now', 1);
        await receive('alloc-now-2', 1);

        const res = await pressRefresh();
        expect(res.status).toBe(200);
        expect(res.data).toEqual({ ready: 2, failed: 0 });
        expect(await statusOf(complete)).toBe('ready_to_ship');
        expect(await statusOf(inBuying)).toBe('ready_to_ship');
        expect(await statusOf(short)).toBe('requested');
        expect(
          await packs.listProcurementSnapshots({}, { take: 5 }),
        ).toHaveLength(0);

        // The press is audited against the staff member, not the system actor.
        const audits = await packs.listAdminActionAudits(
          { entity_id: complete },
          { take: 5 },
        );
        expect(audits).toHaveLength(2); // requested -> processed -> ready
        for (const audit of audits) {
          expect(audit.admin_id).toMatch(/^user_/);
          expect(audit.reason).toBe(
            'stock allocation (refresh): all cards on hand',
          );
        }

        // 12am still does the rest, and the press did not use up its one run.
        await midnight();
        expect(await statusOf(short)).toBe('processed');
        expect(
          await packs.listProcurementSnapshots({}, { take: 5 }),
        ).toHaveLength(1);
      });

      it('Refresh keeps strict oldest-first: a newer order waits behind an older one holding the card', async () => {
        await makeProduct('alloc-queue');
        await makeProduct('alloc-missing');
        const older = await requestOrder('cus_q1', [
          'alloc-queue',
          'alloc-missing',
        ]);
        const newer = await requestOrder('cus_q2', ['alloc-queue']);
        await receive('alloc-queue', 1);

        const res = await pressRefresh();
        expect(res.data).toEqual({ ready: 0, failed: 0 });
        expect(await statusOf(older)).toBe('requested');
        expect(await statusOf(newer)).toBe('requested');
      });

      it('Refresh moves nothing while STOCK_AUTO_ALLOCATION is off', async () => {
        await makeProduct('alloc-press-off');
        const order = await requestOrder('cus_press_off', ['alloc-press-off']);
        await receive('alloc-press-off', 1);
        process.env.STOCK_AUTO_ALLOCATION = 'false';

        const res = await pressRefresh();
        expect(res.status).toBe(200);
        expect(res.data).toEqual({ ready: 0, failed: 0 });
        expect(await statusOf(order)).toBe('requested');
      });

      it('Refresh needs delivery_order:update: staff who can only read stock are refused and nothing moves', async () => {
        await makeProduct('alloc-fence');
        const order = await requestOrder('cus_fence', ['alloc-fence']);
        await receive('alloc-fence', 1);

        const container = getContainer();
        const rbac = container.resolve(Modules.RBAC) as any;
        const [role] = await rbac.createRbacRoles([{ name: 'alloc-reader' }]);
        const policies = await rbac.listRbacPolicies({
          resource: ['inventory', 'inventory_item'],
          operation: ['read'],
        });
        expect(policies).toHaveLength(2);
        await rbac.createRbacRolePolicies(
          policies.map((p: { id: string }) => ({
            role_id: role.id,
            policy_id: p.id,
          })),
        );
        const { http } = container.resolve(
          ContainerRegistrationKeys.CONFIG_MODULE,
        ).projectConfig;
        const reader = generateJwtToken(
          {
            actor_id: 'alloc-reader',
            actor_type: 'user',
            // A login with an authenticator set up: /admin answers no
            // staff token without.
            auth_identity_id: await staffIdentityWithAuthenticator(container),
            app_metadata: { user_id: 'alloc-reader', roles: [role.id] },
            user_metadata: {},
          },
          {
            secret: http.jwtSecret as string,
            expiresIn: 300,
            jwtOptions: http.jwtOptions,
          },
        );

        const asReader = { headers: { authorization: `Bearer ${reader}` } };
        // The token works: this staff member can read stock, just not move orders.
        expect(
          (await unwrapResponse(api.get('/admin/inventory', asReader))).status,
        ).toBe(200);
        const res = await pressRefresh(asReader);
        expect(res.status).toBe(403);
        expect(await statusOf(order)).toBe('requested');
      });

      it('staff can step a ready order back after a GRN reversal; it waits until the cards are covered again', async () => {
        await makeProduct('alloc-back');
        const order = await requestOrder('cus_back', ['alloc-back']);
        const grn = (await receive('alloc-back', 1)).data.goods_receive_note.id;
        await pressRefresh();
        expect(await statusOf(order)).toBe('ready_to_ship');

        // The GRN was a typo: reversing it moves no order by itself.
        const reversed = await unwrapResponse(
          api.post(`/admin/goods-receive-notes/${grn}/reverse`, {}, headers()),
        );
        expect(reversed.status).toBeLessThan(300);
        expect(await statusOf(order)).toBe('ready_to_ship');

        const back = await unwrapResponse(
          api.post(
            `/admin/delivery-orders/${order}`,
            { status: 'processed' },
            headers(),
          ),
        );
        expect(back.status).toBe(200);
        expect(await statusOf(order)).toBe('processed');

        // Short now, so a press leaves it alone.
        expect((await pressRefresh()).data).toEqual({ ready: 0, failed: 0 });
        expect(await statusOf(order)).toBe('processed');

        // Back on the shelf, so the next press completes it again.
        await receive('alloc-back', 1);
        expect((await pressRefresh()).data).toEqual({ ready: 1, failed: 0 });
        expect(await statusOf(order)).toBe('ready_to_ship');
      });

      const getToBuy = async () =>
        (await unwrapResponse(api.get('/admin/procurement/to-buy', headers())))
          .data as {
          taken_at: string | null;
          rows: Array<{ handle: string; to_procure: number }>;
        };

      it('moves and freezes nothing while STOCK_AUTO_ALLOCATION is off; to-buy is live even with a snapshot from before', async () => {
        await makeProduct('alloc-off');
        const order = await requestOrder('cus_off', ['alloc-off']);
        // Left over from while the switch was on.
        await packs.createProcurementSnapshots({
          taken_at: new Date(),
          to_buy: { rows: [] },
        });
        process.env.STOCK_AUTO_ALLOCATION = 'false';
        await midnight();
        expect(await statusOf(order)).toBe('requested');
        expect(
          await packs.listProcurementSnapshots({}, { take: 5 }),
        ).toHaveLength(1);
        const toBuy = (
          await unwrapResponse(api.get('/admin/procurement/to-buy', headers()))
        ).data;
        expect(toBuy.taken_at).toBeNull();
        expect(toBuy.rows.map((r: { handle: string }) => r.handle)).toEqual([
          'alloc-off',
        ]);
      });

      it('a snapshot from before the last 12am is not served: to-buy falls back to live', async () => {
        await makeProduct('alloc-stale');
        await requestOrder('cus_stale', ['alloc-stale']);
        await packs.createProcurementSnapshots({
          taken_at: new Date(Date.now() - 2 * 24 * 3600 * 1000),
          to_buy: { rows: [] },
        });
        const toBuy = await getToBuy();
        expect(toBuy.taken_at).toBeNull();
        expect(toBuy.rows.map((r) => r.handle)).toEqual(['alloc-stale']);
      });

      it('each to-buy row carries its picture (graded: the baked slab) and the PriceCharting price with no markup', async () => {
        await makeProduct('look-slab');
        await makeProduct('look-raw');
        const [slabCard] = await packs.createCards([
          {
            handle: 'look-slab',
            name: 'Look Slab',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: 12.34,
            image: '/cdn/look-slab-card.webp',
            slab_image: '/cdn/look-slab.webp',
          },
          {
            handle: 'look-raw',
            name: 'Look Raw',
            set: 'Test Set',
            grader: '',
            grade: '',
            market_value: 2,
            image: '/cdn/look-raw.webp',
            slab_image: '/cdn/never-shown.webp',
          },
        ]);
        await requestOrder('cus_look', ['look-slab', 'look-raw']);
        type Looked = {
          taken_at: string | null;
          rows: Array<{
            handle: string;
            image: string | null;
            fmv_usd: number | null;
            fmv: number | null;
          }>;
        };
        const look = async () => {
          const list = (await getToBuy()) as unknown as Looked;
          return {
            taken_at: list.taken_at,
            rows: list.rows.map((r) => [r.handle, r.image, r.fmv_usd, r.fmv]),
          };
        };
        // FX pinned at 4.5 above: RM = USD × 4.5, not × 1.2 on top.
        const expected = [
          ['look-raw', '/cdn/look-raw.webp', 2, 9],
          ['look-slab', '/cdn/look-slab.webp', 12.34, 55.53],
        ];
        expect((await look()).rows).toEqual(expected);

        // After the 12am run too: the picture and the price are read when the
        // page loads.
        await midnight();
        const frozen = await look();
        expect(frozen.taken_at).not.toBeNull();
        expect(frozen.rows).toEqual(expected);
        await packs.updateCards([
          {
            id: slabCard.id,
            market_value: 20,
            slab_image: '/cdn/look-slab-rebaked.webp',
          },
        ]);
        expect(await look()).toEqual({
          taken_at: frozen.taken_at,
          rows: [
            expected[0],
            ['look-slab', '/cdn/look-slab-rebaked.webp', 20, 90],
          ],
        });
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
        await midnight();
        expect(await statusOf(order)).toBe('ready_to_ship');
      });

      it('two 12am runs at once never move one order twice and never throw', async () => {
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
          runStockAllocation(getContainer(), { nightly: true }),
          runStockAllocation(getContainer(), { nightly: true }),
        ]);
        expect(await statusOf(order)).toBe('ready_to_ship');
        // Exactly one run made the final move; the other either found it
        // already moved or lost the race cleanly.
        expect(
          [...a.ready, ...b.ready].filter((id) => id === order),
        ).toHaveLength(1);
        // The whole job twice at once (statuses + snapshot) never throws.
        await Promise.all([midnight(), midnight()]);
      });

      it('to-buy: orders as of the 12am run, stock live, by oldest waiting order; to-ship lists ready orders oldest first', async () => {
        await makeProduct('buy-late');
        await makeProduct('buy-early');
        await makeProduct('ship-card');
        const first = await requestOrder('cus_p1', ['buy-early']);
        await requestOrder('cus_p2', ['buy-late', 'buy-late']);
        const shipOld = await requestOrder('cus_p3', ['ship-card']);
        const shipNew = await requestOrder('cus_p4', ['ship-card']);
        await receive('ship-card', 2);
        // Switch on, no 12am run yet: the live list.
        expect((await getToBuy()).taken_at).toBeNull();
        await midnight();
        expect(await statusOf(shipOld)).toBe('ready_to_ship');
        expect(await statusOf(shipNew)).toBe('ready_to_ship');
        expect(await statusOf(first)).toBe('processed');

        const frozen = await getToBuy();
        expect(frozen.taken_at).not.toBeNull();
        expect(frozen.rows.map((r) => [r.handle, r.to_procure])).toEqual([
          ['buy-early', 1],
          ['buy-late', 2],
        ]);
        // A card arriving during the day comes off the list at once (user
        // 2026-11-11: staff bought duplicates waiting for 12am); the order
        // still waits for the next 12am run.
        await receive('buy-early', 1);
        const afterGrn = await getToBuy();
        expect(afterGrn.taken_at).toBe(frozen.taken_at);
        expect(afterGrn.rows.map((r) => [r.handle, r.to_procure])).toEqual([
          ['buy-late', 2],
        ]);
        expect(await statusOf(first)).toBe('processed');

        // An order placed after the 12am run can still be canceled today, so
        // it joins the list only at the next 12am.
        await requestOrder('cus_p5', ['buy-late']);
        expect(
          (await getToBuy()).rows.map((r) => [r.handle, r.to_procure]),
        ).toEqual([['buy-late', 2]]);

        // The next 12am run picks both up: the order ships, the new order
        // joins, and the newest run's time replaces the old one.
        await midnight(nextNight());
        expect(await statusOf(first)).toBe('ready_to_ship');
        const next = await getToBuy();
        expect(next.taken_at! > frozen.taken_at!).toBe(true);
        expect(next.rows.map((r) => [r.handle, r.to_procure])).toEqual([
          ['buy-late', 3],
        ]);

        const toShip = (
          await unwrapResponse(api.get('/admin/procurement/to-ship', headers()))
        ).data.orders as Array<{ id: string; items: unknown[] }>;
        // first shipped on the second 12am run; it is the oldest order.
        expect(toShip.map((o) => o.id)).toEqual([first, shipOld, shipNew]);
        expect(toShip[0].items).toHaveLength(1);
      });
    });
  },
});
