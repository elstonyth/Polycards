import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'pc-collection-test-pw-1';
const ADMIN_EMAIL = 'admin-pc-collection@test.dev';

// Mounting + auth only. The happy path talks to PriceCharting's paid API and is
// not reachable from CI, and the request the route BUILDS (status=collection,
// cursor pass-through, optional seller) is covered by the stubbed-fetch unit
// spec — asserting it here is impossible, because the no-token guard answers
// before req.query is ever read. What only a booted app can prove is what
// stays: the route is mounted, admin-protected, and reports a missing token as
// a setup message rather than as an empty collection.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET /admin/pricecharting/collection', () => {
      let adminToken: string;
      let savedToken: string | undefined;

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        savedToken = process.env.PRICECHARTING_API_TOKEN;
      });

      afterEach(() => {
        // Restore rather than delete: a developer running this locally has the
        // token configured, and a leaked deletion would break later specs.
        if (savedToken === undefined)
          delete process.env.PRICECHARTING_API_TOKEN;
        else process.env.PRICECHARTING_API_TOKEN = savedToken;
      });

      const adminHeaders = () => ({
        headers: { authorization: `Bearer ${adminToken}` },
      });

      it('is admin-protected', async () => {
        const res = await unwrapResponse(
          api.get('/admin/pricecharting/collection'),
        );
        expect(res.status).toBe(401);
      });

      it('503s with a setup message when the API token is not configured', async () => {
        delete process.env.PRICECHARTING_API_TOKEN;

        const res = await unwrapResponse(
          api.get('/admin/pricecharting/collection', adminHeaders()),
        );
        expect(res.status).toBe(503);
        expect(res.data.message).toContain('PRICECHARTING_API_TOKEN');
      });

    });
  },
});
