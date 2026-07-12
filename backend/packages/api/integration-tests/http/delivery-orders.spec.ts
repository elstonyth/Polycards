import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { unwrapResponse, mintSuperAdmin } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'del-test-password-1';
const PACK_SLUG = 'del-pack';
const CARD_HANDLE = 'del-card';
const FMV = 25;
const PACK_PRICE = 5;
const TOPUP = 5 * PACK_PRICE;

// The in-memory workflow-engine / event-bus is now forced for ALL integration
// tests in medusa-config.ts (gated on TEST_TYPE), so this suite no longer needs
// to blank REDIS_URL to dodge the BullMQ "Connection is closed" teardown
// rejection — and crucially no longer leaks a blanked REDIS_URL into the
// later rate-limit suites under --runInBand. See medusa-config `isIntegrationTest`.

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('delivery orders', () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'delivery-test',
          type: 'publishable',
          created_by: 'delivery-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        await packs.createPacks([
          {
            slug: PACK_SLUG,
            title: 'Del Test Pack',
            category: 'pokemon',
            price: PACK_PRICE,
            image: '/cdn/test-pack.webp',
            buyback_percent: 90,
          },
        ]);
        await packs.createCards([
          {
            handle: CARD_HANDLE,
            name: 'Del Test Card',
            set: 'Test Set',
            grader: 'PSA',
            grade: '10',
            market_value: FMV,
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
      });

      const authed = (token: string) => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });
      const reqApi = (
        method: 'get' | 'post',
        path: string,
        headers: Record<string, string>,
        body?: unknown,
      ) =>
        unwrapResponse(
          method === 'get'
            ? api.get(path, { headers })
            : api.post(path, body ?? {}, { headers }),
        );

      const registerCustomer = async (email: string): Promise<string> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        await api.post(
          '/store/customers',
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
        return login.data.token;
      };

      // Create a vaulted pull for `token` via the real open flow; returns pull id.
      const openOne = async (token: string): Promise<string> => {
        await api.post(
          '/store/credits/topup',
          { amount: TOPUP },
          { headers: { ...authed(token), 'idempotency-key': 'delivery-orders-topup' } },
        );
        const open = await reqApi(
          'post',
          `/store/packs/${PACK_SLUG}/open`,
          authed(token),
        );
        return open.data.pull.id as string;
      };

      // Add a Medusa customer address; returns its id.
      const addAddress = async (token: string): Promise<string> => {
        const res = await api.post(
          '/store/customers/me/addresses',
          {
            first_name: 'Ada',
            last_name: 'Lovelace',
            address_1: '1 Analytical Way',
            city: 'London',
            postal_code: 'EC1',
            country_code: 'gb',
          },
          { headers: authed(token) },
        );
        const list = res.data.customer.addresses;
        return list[list.length - 1].id as string;
      };

      it('rejects unauthenticated access with 401', async () => {
        expect(
          (await reqApi('get', '/store/delivery-orders', storeHeaders)).status,
        ).toBe(401);
        expect(
          (await reqApi('post', '/store/delivery-orders', storeHeaders)).status,
        ).toBe(401);
      });

      it('rejects a pull_ids batch over the 500 cap with INVALID_DATA', async () => {
        const token = await registerCustomer('del-cap@test.dev');
        // 501 well-formed string ids + a non-empty address: the shape check
        // passes, so the failure must come from the length cap (which fires
        // before the workflow — no real pulls needed).
        const over = await reqApi(
          'post',
          '/store/delivery-orders',
          authed(token),
          {
            pull_ids: Array.from({ length: 501 }, (_, i) => `pull_${i}`),
            address_id: 'addr_dummy',
          },
        );
        expect(over.status).toBe(400);
        // Assert it's the CAP, not an unrelated 400.
        expect(JSON.stringify(over.data)).toMatch(/500/);
      });

      it('request → delivering, lists order; foreign + non-vaulted rejected; admin ships + delivers', async () => {
        const tokenA = await registerCustomer('del-a@test.dev');
        const tokenB = await registerCustomer('del-b@test.dev');
        const pullId = await openOne(tokenA);
        const addressId = await addAddress(tokenA);

        // Foreign customer cannot deliver A's pull → 404 (no existence leak).
        const foreign = await reqApi(
          'post',
          '/store/delivery-orders',
          authed(tokenB),
          { pull_ids: [pullId], address_id: addressId },
        );
        expect(foreign.status).toBe(404);

        // Owner requests delivery.
        const created = await reqApi(
          'post',
          '/store/delivery-orders',
          authed(tokenA),
          { pull_ids: [pullId], address_id: addressId },
        );
        expect(created.status).toBe(201);
        const orderId = created.data.order_id;
        expect(typeof orderId).toBe('string');
        expect(created.data.status).toBe('requested');

        // Pull left the vault (status delivering) — re-requesting it now rejects.
        // The step throws MedusaError NOT_ALLOWED for the not_vaulted verdict,
        // and Medusa's error-handler maps NOT_ALLOWED → 400 (NOT 409 — the plan
        // guessed 409; confirmed against framework error-handler.js and the
        // vault-buyback "already sold back" path, which also 400s).
        const reReq = await reqApi(
          'post',
          '/store/delivery-orders',
          authed(tokenA),
          { pull_ids: [pullId], address_id: addressId },
        );
        expect(reReq.status).toBe(400);

        // List shows the order with one item.
        const list = await reqApi(
          'get',
          '/store/delivery-orders',
          authed(tokenA),
        );
        expect(list.status).toBe(200);
        expect(list.data.items).toHaveLength(1);
        expect(list.data.items[0]).toMatchObject({
          id: orderId,
          status: 'requested',
        });
        expect(list.data.items[0].items).toHaveLength(1);
        expect(list.data.items[0].items[0].pull_id).toBe(pullId);

        // Admin: list + filter + advance status.
        const adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'del-admin@test.dev',
          'admin-pass-1',
        );
        const adminHeaders = { authorization: `Bearer ${adminToken}` };
        const adminList = await reqApi(
          'get',
          '/admin/delivery-orders?status=requested',
          adminHeaders,
        );
        expect(adminList.status).toBe(200);
        expect(
          adminList.data.orders.some((o: { id: string }) => o.id === orderId),
        ).toBe(true);

        // requested → packing
        expect(
          (
            await reqApi(
              'post',
              `/admin/delivery-orders/${orderId}`,
              adminHeaders,
              { status: 'packing' },
            )
          ).status,
        ).toBe(200);
        // packing → shipped WITHOUT tracking → 400 (INVALID_DATA: tracking_required)
        expect(
          (
            await reqApi(
              'post',
              `/admin/delivery-orders/${orderId}`,
              adminHeaders,
              { status: 'shipped' },
            )
          ).status,
        ).toBe(400);
        // packing → shipped WITH tracking → 200
        expect(
          (
            await reqApi(
              'post',
              `/admin/delivery-orders/${orderId}`,
              adminHeaders,
              { status: 'shipped', tracking_number: 'TRACK123' },
            )
          ).status,
        ).toBe(200);
        // shipped → delivered → 200, pull becomes delivered
        expect(
          (
            await reqApi(
              'post',
              `/admin/delivery-orders/${orderId}`,
              adminHeaders,
              { status: 'delivered' },
            )
          ).status,
        ).toBe(200);

        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [pull] = await packs.listPulls({ id: pullId }, { take: 1 });
        expect(pull.status).toBe('delivered');
      });

      it('cancel returns the pulls to the vault; address edit allowed pre-ship, blocked post-ship', async () => {
        const token = await registerCustomer('del-c@test.dev');
        const pullId = await openOne(token);
        const addressId = await addAddress(token);
        const created = await reqApi(
          'post',
          '/store/delivery-orders',
          authed(token),
          { pull_ids: [pullId], address_id: addressId },
        );
        expect(created.status).toBe(201);
        const orderId = created.data.order_id;

        // Address edit allowed while requested.
        const edit = await reqApi(
          'post',
          `/store/delivery-orders/${orderId}/address`,
          authed(token),
          { address_id: addressId },
        );
        expect(edit.status).toBe(200);

        const adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'del-admin2@test.dev',
          'admin-pass-2',
        );
        const adminHeaders = { authorization: `Bearer ${adminToken}` };
        const canceled = await reqApi(
          'post',
          `/admin/delivery-orders/${orderId}`,
          adminHeaders,
          { status: 'canceled' },
        );
        expect(canceled.status).toBe(200);

        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [pull] = await packs.listPulls({ id: pullId }, { take: 1 });
        expect(pull.status).toBe('vaulted'); // returned to the vault
      });

      it('blocks an address edit once the order has shipped', async () => {
        const token = await registerCustomer('del-d@test.dev');
        const pullId = await openOne(token);
        const addressId = await addAddress(token);
        const created = await reqApi(
          'post',
          '/store/delivery-orders',
          authed(token),
          { pull_ids: [pullId], address_id: addressId },
        );
        expect(created.status).toBe(201);
        const orderId = created.data.order_id;

        const adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'del-admin3@test.dev',
          'admin-pass-3',
        );
        const adminHeaders = { authorization: `Bearer ${adminToken}` };
        // Drive the order to shipped (requested → packing → shipped+tracking).
        expect(
          (
            await reqApi(
              'post',
              `/admin/delivery-orders/${orderId}`,
              adminHeaders,
              { status: 'packing' },
            )
          ).status,
        ).toBe(200);
        expect(
          (
            await reqApi(
              'post',
              `/admin/delivery-orders/${orderId}`,
              adminHeaders,
              { status: 'shipped', tracking_number: 'TRACK999' },
            )
          ).status,
        ).toBe(200);

        // Editing the address after shipping is locked → NOT_ALLOWED → 400.
        const edit = await reqApi(
          'post',
          `/store/delivery-orders/${orderId}/address`,
          authed(token),
          { address_id: addressId },
        );
        expect(edit.status).toBe(400);
      });
    });
  },
});
