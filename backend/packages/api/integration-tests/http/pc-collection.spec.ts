import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'pc-collection-test-pw-1';
const ADMIN_EMAIL = 'admin-pc-collection@test.dev';

// Mounting + auth + the configuration guards. The happy path talks to
// PriceCharting's paid API and is not reachable from CI; the request the route
// BUILDS (status=collection, seller, cursor pass-through) is covered by the
// stubbed-fetch unit spec. What a booted app proves is that the route is
// mounted, admin-protected, and refuses to run when it is not configured —
// which matters most for the seller id, because without it PriceCharting
// answers with EVERY user's offers rather than ours.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET /admin/pricecharting/collection', () => {
      let adminToken: string;
      let savedToken: string | undefined;
      let savedSeller: string | undefined;

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        savedToken = process.env.PRICECHARTING_API_TOKEN;
        savedSeller = process.env.PRICECHARTING_SELLER_ID;
      });

      afterEach(() => {
        // Restore rather than delete: a developer running this locally has both
        // configured, and a leaked deletion would break later specs.
        if (savedToken === undefined)
          delete process.env.PRICECHARTING_API_TOKEN;
        else process.env.PRICECHARTING_API_TOKEN = savedToken;
        if (savedSeller === undefined)
          delete process.env.PRICECHARTING_SELLER_ID;
        else process.env.PRICECHARTING_SELLER_ID = savedSeller;
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

      it('503s with a setup message when the seller id is not configured', async () => {
        delete process.env.PRICECHARTING_SELLER_ID;

        const res = await unwrapResponse(
          api.get('/admin/pricecharting/collection', adminHeaders()),
        );
        expect(res.status).toBe(503);
        expect(res.data.message).toContain('PRICECHARTING_SELLER_ID');
      });

      it('503s with a setup message when the API token is not configured', async () => {
        process.env.PRICECHARTING_SELLER_ID = 'seller_test';
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
