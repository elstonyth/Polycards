// integration-tests/http/disabled-login.spec.ts
// POLYCARD-BACK §4.2 — an administratively disabled player must be locked out
// at BOTH doors: emailpass login (401) and any already-minted bearer on /store
// (403). The second half is what makes this a real block rather than a login
// speed bump — a token issued before the disable (incl. a Google-minted one)
// must stop working immediately.
//
// TDD: RED first — with no guards registered, a disabled customer logs in fine
// and their pre-disable bearer keeps reading /store/credits.
import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'disabled-login-test-pw-1'; // gitleaks:allow
const ADMIN_EMAIL = 'disabled-login-admin@test.dev';
const PLAYER_EMAIL = 'disabled-login-player@test.dev';

/**
 * The customer id as the API sees it — the `actor_id` claim of a LOGIN token.
 * A register token carries an empty actor_id until POST /store/customers links
 * the auth identity to a customer, so it must never be the source here.
 */
const actorIdOf = (token: string): string =>
  JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'))
    .actor_id as string;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('disabled player: login + session block (POLYCARD-BACK §4.2)', () => {
      let storeHeaders: Record<string, string>;
      let adminToken: string;
      let customerId: string;
      let preDisableToken: string;

      beforeEach(async () => {
        const container = getContainer();

        // Publishable API key required for /store/* endpoints.
        const apiKey = container.resolve(Modules.API_KEY);
        const key = await apiKey.createApiKeys({
          title: 'disabled-login-test',
          type: 'publishable',
          created_by: 'disabled-login-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        adminToken = await mintSuperAdmin(container, api, ADMIN_EMAIL, PASSWORD);

        // Register → link the actor (POST /store/customers) → log in for a real
        // token. Only the login token carries a populated actor_id.
        const reg = await api.post('/auth/customer/emailpass/register', {
          email: PLAYER_EMAIL,
          password: PASSWORD,
        });
        await api.post(
          '/store/customers',
          { email: PLAYER_EMAIL },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        const login = await api.post('/auth/customer/emailpass', {
          email: PLAYER_EMAIL,
          password: PASSWORD,
        });
        preDisableToken = login.data.token;
        customerId = actorIdOf(preDisableToken);
        expect(customerId).toBeTruthy();
      });

      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });
      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
      });
      const login = (email = PLAYER_EMAIL) =>
        unwrapResponse(
          api.post('/auth/customer/emailpass', { email, password: PASSWORD }),
        );
      const setDisabled = (disabled: boolean) =>
        unwrapResponse(
          api.post(
            `/admin/customers/${customerId}/${disabled ? 'disable' : 'enable'}`,
            { reason: disabled ? 'test disable' : 'test enable' },
            { headers: adminHeaders() },
          ),
        );

      it('(1) baseline: an enabled player logs in and reads /store/credits', async () => {
        const res = await login();
        expect(res.status).toBe(200);
        expect(res.data.token).toBeTruthy();

        const credits = await unwrapResponse(
          api.get('/store/credits', { headers: authed(res.data.token) }),
        );
        expect(credits.status).toBe(200);

        // The blanket /store guard must be invisible to PUBLIC store routes —
        // no auth_context means pass through, never a 403.
        const publicRead = await unwrapResponse(
          api.get('/store/packs', { headers: storeHeaders }),
        );
        expect(publicRead.status).toBe(200);
      });

      it('(2) disabled → emailpass login is refused with 401', async () => {
        expect((await setDisabled(true)).status).toBe(200);

        const res = await login();
        expect(res.status).toBe(401);
        expect(String(res.data.message)).toMatch(/disabled/i);
      });

      it('(3) disabled → the PRE-disable bearer is dead on /store/credits (403)', async () => {
        expect((await setDisabled(true)).status).toBe(200);

        const res = await unwrapResponse(
          api.get('/store/credits', { headers: authed(preDisableToken) }),
        );
        expect(res.status).toBe(403);
        expect(String(res.data.message)).toMatch(/disabled/i);
      });

      it('(4) re-enabled → login works again and the old bearer is live again', async () => {
        await setDisabled(true);
        expect((await setDisabled(false)).status).toBe(200);

        const res = await login();
        expect(res.status).toBe(200);
        expect(res.data.token).toBeTruthy();

        const credits = await unwrapResponse(
          api.get('/store/credits', { headers: authed(preDisableToken) }),
        );
        expect(credits.status).toBe(200);
      });

      it('(5) an unknown email still falls through to the core auth error', async () => {
        // The guard must never become an account-existence oracle: an unknown
        // email gets core's own 401, NOT our "disabled" message.
        const res = await login('disabled-login-nobody@test.dev');
        expect(res.status).toBe(401);
        expect(String(res.data.message ?? '')).not.toMatch(/disabled/i);
      });
    });
  },
});
