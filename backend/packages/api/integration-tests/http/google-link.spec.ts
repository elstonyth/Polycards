import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import type { IAuthModuleService } from '@medusajs/framework/types';
// Declared at the workspace root (backend/package.json), reached via hoisting
// — the same import src/scripts/qa-mint-google-customer.ts relies on.
import jwt from 'jsonwebtoken';
import { postStoreCustomer, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'google-link-pw-1'; // gitleaks:allow

// POST /store/customers/link-google against the real auth + customer modules.
// The unit spec pins the route's decisions; this pins the three things a mock
// cannot: that core really does refuse the registration this recovers from,
// that `app_metadata.customer_id` written here is what /auth/token/refresh
// turns into an actor, and that the linked account still reads as a password
// account afterwards.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('POST /store/customers/link-google', () => {
      let storeHeaders: Record<string, string>;

      const auth = (): IAuthModuleService =>
        getContainer().resolve<IAuthModuleService>(Modules.AUTH);

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });

      /** Register with a password and link the actor, exactly as the
       *  storefront signup does. */
      const registerWithPassword = async (email: string): Promise<string> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        const created = await postStoreCustomer(
          api,
          getContainer(),
          { email },
          { headers: authed(reg.data.token) },
        );
        return created.data.customer.id as string;
      };

      /** What the Google provider leaves behind after a first sign-in: an
       *  identity carrying the verified email in user_metadata and no actor,
       *  plus the register-phase token core mints for it (actor_id ''). The
       *  claims are the ones authenticate() reads, minted the way
       *  src/scripts/qa-mint-google-customer.ts does — plus `auth_provider`,
       *  which /auth/token/refresh refuses without ("The auth provider is not
       *  set while refreshing token") and which core's callback token
       *  carries. */
      const googleRegisterToken = async (
        email: string,
        sub: string,
      ): Promise<{ identityId: string; token: string }> => {
        const identity = await auth().createAuthIdentities({
          provider_identities: [
            { provider: 'google', entity_id: sub, user_metadata: { email } },
          ],
        });
        const { jwtSecret } =
          getContainer().resolve('configModule').projectConfig.http;
        const token = jwt.sign(
          {
            actor_id: '',
            actor_type: 'customer',
            auth_identity_id: identity.id,
            auth_provider: 'google',
            app_metadata: {},
          },
          jwtSecret as string,
          { expiresIn: '1h' },
        );
        return { identityId: identity.id, token };
      };

      const claimsOf = (token: string): { actor_id?: string } =>
        JSON.parse(
          Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8'),
        ) as { actor_id?: string };

      beforeEach(async () => {
        const apiKeyModule = getContainer().resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'google-link-test',
          type: 'publishable',
          created_by: 'google-link-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
      });

      it('attaches the Google identity to the password account holding its email; refresh yields that account', async () => {
        const email = 'linked@test.dev';
        const customerId = await registerWithPassword(email);
        const { identityId, token } = await googleRegisterToken(
          email,
          'sub-linked',
        );

        // The refusal the storefront recovers from — core's, verbatim.
        const dup = await unwrapResponse(
          api.post('/store/customers', { email }, { headers: authed(token) }),
        );
        expect(dup.status).toBe(422);
        expect(dup.data.message).toMatch(/already has an account/i);

        const linked = await api.post(
          '/store/customers/link-google',
          {},
          { headers: authed(token) },
        );
        expect(linked.status).toBe(200);
        expect(linked.data).toEqual({ customer_id: customerId });

        // The same post-register refresh the storefront runs: the register
        // token now resolves to an actor.
        const refreshed = await api.post(
          '/auth/token/refresh',
          {},
          { headers: { authorization: `Bearer ${token}` } },
        );
        const session = refreshed.data.token as string;
        expect(claimsOf(session).actor_id).toBe(customerId);

        const me = await api.get('/store/customers/me', {
          headers: authed(session),
        });
        expect(me.data.customer.email).toBe(email);

        // Still a password account — the phone-change re-auth gate keeps
        // asking it for the password, and the modal cohort read says so.
        const account = await api.get('/store/customers/me/account', {
          headers: authed(session),
        });
        expect(account.data).toMatchObject({ hasPassword: true });

        const [identity] = await auth().listAuthIdentities({
          id: [identityId],
        });
        expect(identity?.app_metadata).toEqual({ customer_id: customerId });
      });

      // An emailpass register token has no Google identity, and signup never
      // verified its email — it must not be able to claim anyone's account.
      it('refuses an emailpass register token', async () => {
        await registerWithPassword('holder@test.dev');
        const reg = await api.post('/auth/customer/emailpass/register', {
          email: 'claimant@test.dev',
          password: PASSWORD,
        });
        const res = await unwrapResponse(
          api.post(
            '/store/customers/link-google',
            {},
            { headers: authed(reg.data.token) },
          ),
        );
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/only a google sign-in/i);
      });

      it('404s when no registered account holds the Google email', async () => {
        const { token } = await googleRegisterToken(
          'nobody@test.dev',
          'sub-nobody',
        );
        const res = await unwrapResponse(
          api.post(
            '/store/customers/link-google',
            {},
            { headers: authed(token) },
          ),
        );
        expect(res.status).toBe(404);
      });

      it('401s without a bearer', async () => {
        const res = await unwrapResponse(
          api.post(
            '/store/customers/link-google',
            {},
            { headers: storeHeaders },
          ),
        );
        expect(res.status).toBe(401);
      });
    });
  },
});
