import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { MercurModules, SellerStatus } from '@mercurjs/types';
import { postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'group-fields-test-password-1';
const GROUP_NAME = 'group-fields-secret-name';
const GROUP_SECRET = 'group-fields-secret-value';
const SELLER_EMAIL = 'house@polycards.local';

// Exact body, not just the 400: a repeated `fields` already gets a 400 from
// core's validator, so a status-only check would stay green with the guard gone.
const REFUSED = {
  type: 'invalid_data',
  message: 'Those fields are not available on this API.',
};

// customer_group.metadata holds private settings (odds_set, the withdrawal
// block), and the seller holds staff and payment details. Every path below
// returned them to the caller until refusePrivateFields and the /store/carts* and
// /store/sellers* blocks (middlewares.ts) went in: core only enforces a route's
// `allowed` list behind the rbac_filter_fields flag, and the /store routes here
// have no `disallowed` entry for them. Unwire any of these and this file goes red.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('customer group fields on /store', () => {
      let anon: Record<string, string>;
      let authed: Record<string, string>;
      let regionId: string;
      let customerId: string;
      let addressId: string;
      let sellerId: string;
      let orderId: string;
      let cartId: string;

      const address = {
        first_name: 'Ash',
        last_name: 'Ketchum',
        address_1: '1 Jalan Pallet',
        city: 'Kuala Lumpur',
        postal_code: '50000',
        country_code: 'my',
        phone: '+60123456789',
      };

      const send = (
        method: 'get' | 'post' | 'delete',
        path: string,
        headers: Record<string, string>,
        body?: unknown,
      ) =>
        unwrapResponse(
          method === 'post'
            ? api.post(path, body, { headers })
            : api[method](path, { headers }),
        );

      // One object, so a failure names the request that got through.
      const expectRefused = async (
        method: 'get' | 'post' | 'delete',
        path: string,
        headers: Record<string, string>,
        body?: unknown,
      ) => {
        const res = await send(method, path, headers, body);
        expect({ path, status: res.status, data: res.data }).toEqual({
          path,
          status: 400,
          data: REFUSED,
        });
      };

      beforeEach(async () => {
        const container = getContainer();
        const key = await container.resolve(Modules.API_KEY).createApiKeys({
          title: 'group-fields-test',
          type: 'publishable',
          created_by: 'group-fields-test',
        });
        anon = { 'x-publishable-api-key': key.token };

        const region = await container.resolve(Modules.REGION).createRegions({
          name: 'Malaysia',
          currency_code: 'myr',
          countries: ['my'],
        });
        regionId = region.id;
        const salesChannel = await container
          .resolve(Modules.SALES_CHANNEL)
          .createSalesChannels({ name: 'group-fields-test' });
        const link = container.resolve(ContainerRegistrationKeys.LINK);
        await link.create({
          [Modules.API_KEY]: { publishable_key_id: key.id },
          [Modules.SALES_CHANNEL]: { sales_channel_id: salesChannel.id },
        });

        const email = 'group-fields@test.dev';
        const registered = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        const created = await postStoreCustomer(
          api,
          container,
          { email },
          {
            headers: {
              ...anon,
              authorization: `Bearer ${registered.data.token}`,
            },
          },
        );
        customerId = created.data.customer.id;
        const login = await api.post('/auth/customer/emailpass', {
          email,
          password: PASSWORD,
        });
        authed = { ...anon, authorization: `Bearer ${login.data.token}` };

        const customers = container.resolve(Modules.CUSTOMER);
        const group = await customers.createCustomerGroups({
          name: GROUP_NAME,
          metadata: { odds_set: 3, note: GROUP_SECRET },
        });
        await customers.addCustomerToGroup({
          customer_id: customerId,
          customer_group_id: group.id,
        });

        const sellers = container.resolve<{
          createSellers: (data: unknown[]) => Promise<Array<{ id: string }>>;
        }>(MercurModules.SELLER);
        const [seller] = await sellers.createSellers([
          {
            name: 'House',
            handle: 'house',
            email: SELLER_EMAIL,
            currency_code: 'myr',
            status: SellerStatus.OPEN,
          },
        ]);
        sellerId = seller.id;
        await link.create({
          [Modules.CUSTOMER]: { customer_group_id: group.id },
          [MercurModules.SELLER]: { seller_id: sellerId },
        });

        const order = await container.resolve(Modules.ORDER).createOrders({
          email,
          customer_id: customerId,
          currency_code: 'myr',
          region_id: regionId,
          sales_channel_id: salesChannel.id,
          items: [{ title: 'Pack', quantity: 1, unit_price: 1 }],
        });
        orderId = order.id;
        await link.create({
          [Modules.ORDER]: { order_id: orderId },
          [MercurModules.SELLER]: { seller_id: sellerId },
        });

        const cart = await container.resolve(Modules.CART).createCarts({
          email,
          customer_id: customerId,
          currency_code: 'myr',
          region_id: regionId,
          sales_channel_id: salesChannel.id,
        });
        cartId = cart.id;

        const withAddress = await send(
          'post',
          '/store/customers/me/addresses',
          authed,
          address,
        );
        addressId = withAddress.data.customer.addresses[0].id;
      });

      it('refuses every spelling on GET /store/customers/me', async () => {
        for (const query of [
          'fields=%2Bgroups.metadata',
          'fields=groups.metadata',
          'fields=*groups',
          'fields=groups.*',
          'fields=%2Bgroups.*',
          'fields=%2B*groups',
          // A raw `+` decodes to a space, which core reads as the same modifier.
          'fields=+groups.metadata',
          'fields=%20groups.metadata',
          'fields=id,%2Bgroups.metadata',
          'fields=-id,%2Bgroups.metadata',
          'fields=%67roups.metadata',
          'fields=%2BGroups.metadata',
          'fields=GROUPS.*',
          'fields=*GROUPS',
          'fields=id&fields=%2Bgroups.metadata',
          'fields=%2Bgroups.metadata&fields=id',
          'fields[]=groups.metadata',
          'fields[0]=groups.metadata',
          'fields[a]=groups.metadata',
        ]) {
          await expectRefused('get', `/store/customers/me?${query}`, authed);
        }
      });

      it('refuses the customer write and address routes', async () => {
        await expectRefused(
          'post',
          '/store/customers/me?fields=%2Bgroups.metadata',
          authed,
          { first_name: 'Ash' },
        );
        await expectRefused('post', '/store/customers/me?fields=*groups', authed, {
          first_name: 'Ash',
        });
        const registered = await api.post('/auth/customer/emailpass/register', {
          email: 'group-fields-new@test.dev',
          password: PASSWORD,
        });
        await expectRefused(
          'post',
          '/store/customers?fields=%2Bgroups.metadata',
          { ...anon, authorization: `Bearer ${registered.data.token}` },
          { email: 'group-fields-new@test.dev' },
        );

        const addresses = '/store/customers/me/addresses';
        await expectRefused(
          'get',
          `${addresses}?fields=customer.groups.metadata`,
          authed,
        );
        await expectRefused(
          'get',
          `${addresses}?fields=*customer.groups`,
          authed,
        );
        await expectRefused(
          'post',
          `${addresses}?fields=%2Bgroups.metadata`,
          authed,
          address,
        );
        await expectRefused('post', `${addresses}?fields=*groups`, authed, address);
        const one = `${addresses}/${addressId}`;
        await expectRefused(
          'get',
          `${one}?fields=customer.groups.metadata`,
          authed,
        );
        await expectRefused(
          'post',
          `${one}?fields=%2Bgroups.metadata`,
          authed,
          address,
        );
        await expectRefused('delete', `${one}?fields=groups.metadata`, authed);
      });

      it('refuses the order and payment collection routes', async () => {
        for (const fields of [
          'customer.groups.metadata',
          '%2Bcustomer.groups.metadata',
          '*customer.groups',
        ]) {
          await expectRefused('get', `/store/orders?fields=${fields}`, authed);
          // No auth on this one: an order id is all it takes.
          await expectRefused(
            'get',
            `/store/orders/${orderId}?fields=${fields}`,
            anon,
          );
        }
        for (const fields of [
          '%2Bcart.customer.groups.metadata',
          '*cart.customer.groups',
        ]) {
          await expectRefused(
            'post',
            `/store/payment-collections?fields=${fields}`,
            authed,
            { cart_id: cartId },
          );
        }
      });

      // The anonymous one matters most: an order id is all it takes.
      it('refuses seller fields wherever they are reachable', async () => {
        for (const fields of ['seller.*', '*seller', 'id,seller.email', 'SELLER.*']) {
          await expectRefused('get', `/store/orders/${orderId}?fields=${fields}`, anon);
          await expectRefused('get', `/store/orders?fields=${fields}`, authed);
          await expectRefused('get', `/store/products?fields=${fields}`, anon);
        }
        await expectRefused('get', '/store/customers/me?fields=sellers.*', authed);
        await expectRefused('get', '/store/customers/me?fields=*sellers', authed);
      });

      it('closes /store/sellers* outright, and the guard covers any route like it', async () => {
        for (const path of [
          '/store/sellers',
          '/STORE/SELLERS',
          '/store/sellers?fields=id',
          '/store/sellers?fields=*',
          '/store/sellers?fields=*customer_groups',
          `/store/sellers/${sellerId}`,
          `/store/sellers/${sellerId}?fields=customer_groups.*`,
        ]) {
          const res = await send('get', path, anon);
          expect({ path, status: res.status, message: res.data?.message }).toEqual(
            { path, status: 404, message: 'Not found' },
          );
        }
        // Fields naming groups are refused before any route runs, so a future
        // route with the same relation is covered too.
        await expectRefused(
          'get',
          '/store/regions?fields=customer_groups.metadata',
          anon,
        );
      });

      it('closes /store/carts* outright', async () => {
        const body = { region_id: regionId };
        // The bare calls matter: the default cart fields include
        // customer.groups.id, which no `fields` check can see.
        for (const [method, path, headers, payload] of [
          ['post', '/store/carts', authed, body],
          ['post', '/STORE/CARTS', authed, body],
          ['post', '/store/carts?fields=%2Bcustomer.groups.metadata', authed, body],
          ['post', '/store/carts?fields=*customer.groups', authed, body],
          ['post', '/store/carts?fields=customer.groups.*', authed, body],
          ['post', '/store/carts?fields=*customer', authed, body],
          ['get', `/store/carts/${cartId}`, authed],
          ['get', `/store/carts/${cartId}`, anon],
          ['get', `/store/carts/${cartId}?fields=*customer.groups`, anon],
          ['post', `/store/carts/${cartId}`, authed, {}],
          ['post', `/store/carts/${cartId}/customer`, authed, {}],
          ['post', `/store/carts/${cartId}/complete`, authed, {}],
        ] as const) {
          const res = await send(method, path, headers, payload);
          expect({ path, status: res.status, message: res.data?.message }).toEqual(
            { path, status: 404, message: 'Not found' },
          );
        }
      });

      // These pass without the fix. They pin why the guard can match on the
      // word: a core upgrade that lets a wildcard cross into relations, or a
      // loosened validator, must fail here rather than reopen the leak quietly.
      it('leaves no way round through wildcards or other keys', async () => {
        for (const [path, headers] of [
          ['/store/customers/me?fields=*', authed],
          ['/store/customers/me?fields=*.*', authed],
          ['/store/customers/me?fields=**', authed],
          ['/store/customers/me/addresses?fields=*customer', authed],
          ['/store/customers/me/addresses?fields=customer.*', authed],
          ['/store/orders?fields=*customer', authed],
          [`/store/orders/${orderId}?fields=customer.*`, anon],
          [`/store/orders/${orderId}`, anon],
          [`/store/orders/${orderId}?fields=*`, anon],
        ] as const) {
          const res = await send('get', path, headers);
          const seen = JSON.stringify(res.data);
          expect({
            path,
            status: res.status,
            leaked:
              seen.includes(GROUP_SECRET) ||
              seen.includes(GROUP_NAME) ||
              seen.includes(SELLER_EMAIL),
          }).toEqual({ path, status: 200, leaked: false });
        }
        for (const query of [
          'fields.a=groups.metadata',
          'Fields=groups.metadata',
          'FIELDS=groups.*',
          'expand=groups',
        ]) {
          const res = await send('get', `/store/customers/me?${query}`, authed);
          expect({ query, status: res.status }).toEqual({ query, status: 400 });
        }
      });

      // getCustomerSession treats any non-2xx as logged out, so a false
      // positive on the session read would sign every customer out.
      it('leaves the calls the storefront makes working', async () => {
        await getContainer()
          .resolve(Modules.CUSTOMER)
          .updateCustomers(customerId, { metadata: { marker: 'kept' } });

        const session = await send(
          'get',
          '/store/customers/me?fields=%2Bmetadata',
          authed,
        );
        expect(session.status).toBe(200);
        expect(session.data.customer.metadata.marker).toBe('kept');
        expect(session.data.customer.groups).toBeUndefined();

        const bare = await send('get', '/store/customers/me', authed);
        expect(bare.status).toBe(200);
        expect(bare.data.customer.id).toBe(customerId);

        const renamed = await send('post', '/store/customers/me', authed, {
          first_name: 'Misty',
        });
        expect(renamed.status).toBe(200);
        expect(renamed.data.customer.first_name).toBe('Misty');

        const addresses = await send(
          'get',
          '/store/customers/me/addresses',
          authed,
        );
        expect(addresses.status).toBe(200);
        expect(addresses.data.addresses).toHaveLength(1);
      });
    });
  },
});
