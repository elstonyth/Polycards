// integration-tests/http/invite-attribution-e2e.spec.ts
//
// Exercises the SERVER round-trip of the invite cookie→claim acquisition flow
// end-to-end, using the REAL lazily-assigned profile handle that the invite link
// (/invite/<handle>) and the `polycards_ref` cookie carry.
//
// Client flow (verified by reading src/app/invite/[handle]/InviteClient.tsx and
// src/app/(account)/ReferralCookieClaim.tsx):
//   1. Sponsor's invite link embeds getOwnProfileHandle() == GET /store/profiles/me.
//   2. A guest visiting /invite/<handle> stashes <handle> in the cookie.
//   3. On the guest→authed transition (or first account landing), the client
//      calls applyReferral(<handle>) == POST /store/referral { sponsor_handle }.
//   4. The sponsor then sees the recruit in GET /store/referral.
//
// This test drives steps 1→4 through the real routes (the cookie itself is 3
// lines of document.cookie; the attribution mechanism it triggers is what can
// actually break — handle round-trips sponsor → link → summary).
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { unwrapResponse } from './utils';

jest.setTimeout(180 * 1000);

const PASSWORD = 'invite-e2e-pw-1';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('invite cookie→claim acquisition (server round-trip)', () => {
      let storeHeaders: Record<string, string>;

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

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

      beforeEach(async () => {
        const apiKeyModule = getContainer().resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'invite-e2e-test',
          type: 'publishable',
          created_by: 'invite-e2e-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
      });

      it("sponsor's invite handle attributes a recruit who claims it", async () => {
        // 1) Sponsor gets their invite-link handle (lazily assigned) — the exact
        //    value /invite/<handle> embeds and the cookie stores.
        const sponsorToken = await registerCustomer('invite-sponsor@test.dev');
        const me = await unwrapResponse(
          api.get('/store/profiles/me', { headers: authed(sponsorToken) }),
        );
        expect(me.status).toBe(200);
        const sponsorHandle: string = me.data.handle;
        expect(typeof sponsorHandle).toBe('string');
        expect(sponsorHandle.length).toBeGreaterThan(0);

        // 2) Recruit signs up, then the claim fires: applyReferral(handle) ==
        //    POST /store/referral { sponsor_handle }.
        const recruitToken = await registerCustomer('invite-recruit@test.dev');
        const apply = await unwrapResponse(
          api.post(
            '/store/referral',
            { sponsor_handle: sponsorHandle },
            { headers: authed(recruitToken) },
          ),
        );
        expect(apply.status).toBe(201);

        // 3) Attribution is visible on the sponsor's summary.
        const summary = await unwrapResponse(
          api.get('/store/referral', { headers: authed(sponsorToken) }),
        );
        expect(summary.status).toBe(200);
        expect(summary.data.downstreamCount).toBe(1);
        expect(summary.data.directRecruits).toHaveLength(1);
      });

      it('a stale/unknown cookie handle fails cleanly (400, no crash)', async () => {
        // ReferralCookieClaim fires applyReferral for whatever the cookie holds;
        // a stale handle must 400 (→ friendlyError 'handle does not exist'), not 500.
        const recruitToken = await registerCustomer(
          'invite-badhandle@test.dev',
        );
        const apply = await unwrapResponse(
          api.post(
            '/store/referral',
            { sponsor_handle: 'nope_not_a_real_handle' },
            { headers: authed(recruitToken) },
          ),
        );
        expect(apply.status).toBe(400);
      });

      it('self-referral (own invite link) is rejected', async () => {
        // A user opening their OWN invite link then signing in: applyReferral with
        // their own handle must be rejected (the client keeps the manual button for
        // already-logged-in visitors, but the backend is the real guard).
        const token = await registerCustomer('invite-self@test.dev');
        const me = await unwrapResponse(
          api.get('/store/profiles/me', { headers: authed(token) }),
        );
        const ownHandle: string = me.data.handle;
        const apply = await unwrapResponse(
          api.post(
            '/store/referral',
            { sponsor_handle: ownHandle },
            { headers: authed(token) },
          ),
        );
        expect(apply.status).toBeGreaterThanOrEqual(400);
      });
    });
  },
});
