import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(180 * 1000);

// Task 11 — POST /store/referral
//
// Security invariant: recruitId MUST be bound to req.auth_context.actor_id
// (the verified bearer token), NEVER to a customer_id supplied in the request
// body. The spoof test sends `customer_id: "cus_SPOOF"` in the body and
// asserts it is silently ignored — the relationship is stored against the
// token's actor, not the body field.

const PASSWORD = 'referral-route-pw-1';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('POST /store/referral', () => {
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'referral-route-test',
          type: 'publishable',
          created_by: 'referral-route-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
      });

      /**
       * Register a customer and return their bearer token + actor (customer) id.
       * Mirrors the pattern used by credit-race.spec.ts: register → create
       * customer record → login. The customer's Medusa id IS the actor_id that
       * auth_context.actor_id carries on authenticated /store/* requests.
       */
      const registerAndLogin = async (
        email: string,
      ): Promise<{ token: string; actorId: string }> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        const created = await postStoreCustomer(
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
        const login = await api.post('/auth/customer/emailpass', {
          email,
          password: PASSWORD,
        });
        return {
          token: login.data.token as string,
          actorId: created.data.customer.id as string,
        };
      };

      it('binds the recruit to the authenticated actor, not the body', async () => {
        // The route verifies sponsor_id points to a REAL customer (F7
        // hardening), so the sponsor must exist before it can be linked.
        const sponsor = await registerAndLogin('sponsor-route@polycards.test');
        const { token, actorId } = await registerAndLogin(
          'recruit-route@polycards.test',
        );

        // Send a spoofed customer_id in the body alongside the real sponsor_id.
        // The route must ignore customer_id and bind the relationship to the
        // bearer token's actor (actorId).
        const res = await unwrapResponse(
          api.post(
            '/store/referral',
            { sponsor_id: sponsor.actorId, customer_id: 'cus_SPOOF' },
            { headers: { ...storeHeaders, authorization: `Bearer ${token}` } },
          ),
        );
        expect(res.status).toBe(201);
        expect(res.data.id).toBeTruthy();

        // Verify the relationship is stored against actorId, NOT "cus_SPOOF".
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [rel] = await packs.listReferralRelationships(
          { customer_id: actorId },
          { take: 1 },
        );
        expect(rel).toBeDefined();
        expect(rel.sponsor_id).toBe(sponsor.actorId);

        // Also confirm nothing was stored for the spoofed id.
        const spoofed = await packs.listReferralRelationships(
          { customer_id: 'cus_SPOOF' },
          { take: 1 },
        );
        expect(spoofed).toHaveLength(0);
      });

      it('rejects unauthenticated requests with 401', async () => {
        const res = await unwrapResponse(
          api.post(
            '/store/referral',
            { sponsor_id: 'cus_sponsor_y' },
            { headers: storeHeaders },
          ),
        );
        expect(res.status).toBe(401);
      });

      it('rejects missing sponsor_id with 400', async () => {
        const { token } = await registerAndLogin(
          'recruit-route-nosp@polycards.test',
        );
        const res = await unwrapResponse(
          api.post(
            '/store/referral',
            {},
            { headers: { ...storeHeaders, authorization: `Bearer ${token}` } },
          ),
        );
        expect(res.status).toBe(400);
      });

      it('rejects empty sponsor_id with 400', async () => {
        const { token } = await registerAndLogin(
          'recruit-route-emptysp@polycards.test',
        );
        const res = await unwrapResponse(
          api.post(
            '/store/referral',
            { sponsor_id: '' },
            { headers: { ...storeHeaders, authorization: `Bearer ${token}` } },
          ),
        );
        expect(res.status).toBe(400);
      });
    });
  },
});
