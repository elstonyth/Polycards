import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { postStoreCustomer, unwrapResponse } from './utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';

jest.setTimeout(180 * 1000);

// Task 6 — GET /store/referral
//
// Security invariants:
//   1. An unauthenticated GET must be 401 (not 200/unprotected), asserting the
//      separate GET middleware entry works — the existing /store/referral entry
//      pins method:'POST', so an unguarded GET would fall through unprotected.
//   2. The response NEVER leaks raw customerId on the wire: every directRecruits
//      entry has exactly the keys ['contribution', 'handle'] and nothing more.
//
// Task 7 — POST /store/referral accepts sponsor_handle (server-side resolved)

const PASSWORD = 'store-referral-get-pw-1';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET /store/referral', () => {
      let storeHeaders: Record<string, string>;
      let customerToken: string;

      beforeEach(async () => {
        const container = getContainer();

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'store-referral-get-test',
          type: 'publishable',
          created_by: 'store-referral-get-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        // Register + login a customer.
        const reg = await api.post('/auth/customer/emailpass/register', {
          email: 'store-referral-get-a@test.dev',
          password: PASSWORD,
        });
        await postStoreCustomer(
          api,
          getContainer(),
          { email: 'store-referral-get-a@test.dev' },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        const login = await api.post('/auth/customer/emailpass', {
          email: 'store-referral-get-a@test.dev',
          password: PASSWORD,
        });
        customerToken = login.data.token as string;
      });

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      it('GET /store/referral is auth-protected and omits raw recruit ids', async () => {
        // Unauthenticated GET must be 401 — asserts the separate GET middleware
        // entry is present (the POST entry alone would leave GET unguarded).
        const unauthRes = await unwrapResponse(
          api.get('/store/referral', { headers: storeHeaders }),
        );
        expect(unauthRes.status).toBe(401);

        // Authenticated GET must return 200 with the referral summary shape.
        const res = await unwrapResponse(
          api.get('/store/referral', { headers: authed(customerToken) }),
        );
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({
          downstreamCount: expect.any(Number),
          totalEarned: expect.any(Number),
        });
        expect(Array.isArray(res.data.directRecruits)).toBe(true);

        // Privacy invariant: no customerId on the wire — every directRecruits
        // entry must have EXACTLY ['contribution', 'handle'] and nothing else.
        for (const r of res.data.directRecruits) {
          expect(Object.keys(r).sort()).toEqual(['contribution', 'handle']);
        }
      });
    });

    // Task 7 — POST /store/referral with sponsor_handle
    describe('POST /store/referral — sponsor_handle resolution', () => {
      let storeHeaders: Record<string, string>;
      let sponsorId: string;
      let recruitId: string;
      let recruitToken: string;

      const SPONSOR_HANDLE = 'store-ref-t7-sponsor';

      beforeEach(async () => {
        const container = getContainer();
        const customerService = container.resolve(Modules.CUSTOMER);

        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'store-referral-post-handle-test',
          type: 'publishable',
          created_by: 'store-referral-post-handle-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        // Create a sponsor customer and directly set their handle in metadata.
        const [sponsor] = await customerService.createCustomers([
          {
            email: 'store-ref-t7-sponsor@test.dev',
            metadata: { handle: SPONSOR_HANDLE },
          },
        ]);
        sponsorId = sponsor.id;

        // Register + login the recruit customer.
        const reg = await api.post('/auth/customer/emailpass/register', {
          email: 'store-ref-t7-recruit@test.dev',
          password: PASSWORD,
        });
        const created = await postStoreCustomer(
          api,
          getContainer(),
          { email: 'store-ref-t7-recruit@test.dev' },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        recruitId = created.data.customer.id as string;
        const login = await api.post('/auth/customer/emailpass', {
          email: 'store-ref-t7-recruit@test.dev',
          password: PASSWORD,
        });
        recruitToken = login.data.token as string;
      });

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      it('resolves sponsor_handle server-side and links recruit → sponsor', async () => {
        const res = await unwrapResponse(
          api.post(
            '/store/referral',
            { sponsor_handle: SPONSOR_HANDLE },
            { headers: authed(recruitToken) },
          ),
        );
        expect(res.status).toBe(201);
        expect(res.data).toMatchObject({ id: expect.any(String) });

        // Verify the stored relationship points at the sponsor's actual customer id.
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const rel = await packs.listReferralRelationships(
          { customer_id: recruitId },
          { take: 1 },
        );
        expect(rel[0].sponsor_id).toBe(sponsorId);
      });

      it('unknown sponsor_handle → 4xx', async () => {
        const res = await unwrapResponse(
          api.post(
            '/store/referral',
            { sponsor_handle: 'nope_nobody_xyz_999' },
            { headers: authed(recruitToken) },
          ),
        );
        expect(res.status).toBe(400);
      });
    });
  },
});
