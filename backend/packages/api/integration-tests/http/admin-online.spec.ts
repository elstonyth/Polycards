import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import jwt from 'jsonwebtoken';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// The Dashboard's "online now": the storefront pings POST /store/presence
// while a signed-in tab is visible, and GET /admin/stats/online counts the
// players who pinged in the last 5 minutes. Counts are compared before and
// after, never as absolutes: the presence store is the harness's shared
// Redis when REDIS_URL is set, and other suites may have pinged into it.

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('online now', () => {
      let adminToken: string;
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          'online-admin@test.dev',
          'online-test-password-1',
        );
        const key = await getContainer()
          .resolve(Modules.API_KEY)
          .createApiKeys({
            title: 'online-test',
            type: 'publishable',
            created_by: 'online-test',
          });
        storeHeaders = { 'x-publishable-api-key': key.token };
      });

      const customerToken = (customerId: string): string => {
        const { jwtSecret } =
          getContainer().resolve('configModule').projectConfig.http;
        return jwt.sign(
          {
            actor_id: customerId,
            actor_type: 'customer',
            auth_identity_id: `authid_${customerId}`,
            app_metadata: { customer_id: customerId },
          },
          jwtSecret as string,
          { expiresIn: '1h' },
        );
      };

      const ping = (token?: string) =>
        unwrapResponse(
          api.post(
            '/store/presence',
            {},
            {
              headers: {
                ...storeHeaders,
                ...(token ? { authorization: `Bearer ${token}` } : {}),
              },
            },
          ),
        );

      const online = async (scope: string): Promise<number> => {
        const res = await unwrapResponse(
          api.get(`/admin/stats/online?scope=${scope}`, {
            headers: { authorization: `Bearer ${adminToken}` },
          }),
        );
        expect(res.status).toBe(200);
        expect(res.data.window_minutes).toBe(5);
        return res.data.online as number;
      };

      it('refuses a ping without a customer token, and a read without an admin', async () => {
        expect((await ping()).status).toBe(401);
        expect(
          (await unwrapResponse(api.get('/admin/stats/online'))).status,
        ).toBe(401);
        const bad = await unwrapResponse(
          api.get('/admin/stats/online?scope=partners', {
            headers: { authorization: `Bearer ${adminToken}` },
          }),
        );
        expect(bad.status).toBe(400);
      });

      // Real customers (spec 2026-10-14-admin-finance-pages §3): `grouped` is
      // in a non-default group, so it counts for everyone but not for real.
      it('counts each pinging player once, real customers only under scope=default', async () => {
        const customers = getContainer().resolve(Modules.CUSTOMER);
        const [real, grouped] = await customers.createCustomers([
          { email: 'online-real@test.dev', has_account: true },
          { email: 'online-grouped@test.dev', has_account: true },
        ]);
        const partner = await customers.createCustomerGroups({
          name: 'Online Partners',
        });
        await customers.addCustomerToGroup([
          { customer_id: grouped.id, customer_group_id: partner.id },
        ]);

        const allBefore = await online('all');
        const realBefore = await online('default');

        expect((await ping(customerToken(real.id))).status).toBe(200);
        expect((await ping(customerToken(grouped.id))).status).toBe(200);
        // A second ping from the same player is still one player.
        expect((await ping(customerToken(real.id))).status).toBe(200);

        expect(await online('all')).toBe(allBefore + 2);
        expect(await online('default')).toBe(realBefore + 1);
        // No scope means everyone, as on GET /admin/stats.
        const res = await unwrapResponse(
          api.get('/admin/stats/online', {
            headers: { authorization: `Bearer ${adminToken}` },
          }),
        );
        expect(res.data.online).toBe(allBefore + 2);
      });
    });
  },
});
