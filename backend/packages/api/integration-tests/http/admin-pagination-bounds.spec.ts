import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'pagination-bounds-test-pw-1';
const ADMIN_EMAIL = 'pagination-bounds-admin@test.dev';

// Plan 008 Item E: the admin audit/commissions GET routes must reject clearly
// invalid limit/offset at the boundary with a 400 (the service also clamps, so
// this is API hygiene, not a live DoS). A valid request still returns 200.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('admin audit/commissions pagination bounds', () => {
      let adminToken: string;

      beforeEach(async () => {
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

      const cid = 'cust_pagination_bounds_test';

      it('audit: rejects a negative limit with 400', async () => {
        const res = await unwrapResponse(
          api.get(`/admin/customers/${cid}/audit?limit=-5`, adminHeaders()),
        );
        expect(res.status).toBe(400);
      });

      it('audit: rejects a non-numeric offset with 400', async () => {
        const res = await unwrapResponse(
          api.get(`/admin/customers/${cid}/audit?offset=abc`, adminHeaders()),
        );
        expect(res.status).toBe(400);
      });

      it('commissions: rejects an absurd limit with 400', async () => {
        const res = await unwrapResponse(
          api.get(
            `/admin/customers/${cid}/commissions?limit=99999`,
            adminHeaders(),
          ),
        );
        expect(res.status).toBe(400);
      });

      it('audit: a valid limit/offset still returns 200', async () => {
        const res = await unwrapResponse(
          api.get(
            `/admin/customers/${cid}/audit?limit=10&offset=0`,
            adminHeaders(),
          ),
        );
        expect(res.status).toBe(200);
      });
    });
  },
});
