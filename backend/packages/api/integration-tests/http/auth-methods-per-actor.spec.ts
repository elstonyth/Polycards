import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Staff and sellers sign in with a password only; customers also with Google
// (security audit 2026-11-07). Without an allowlist Medusa lets every
// registered provider serve every actor, the admin login included.
// medusa-config's http.authMethodsPerActor is the allowlist.
//
// Google is registered here as in prod (medusa-config needs all three), so the
// customer case proves a sign-in really starts. Starting one only builds the
// Google URL: nothing is sent to Google.
process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'test-secret';
process.env.GOOGLE_CALLBACK_URL = 'http://localhost:4000/auth/google/callback';

const NOT_ALLOWED = /not allowed to use the auth provider google/;

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api }) => {
    describe('sign-in methods per actor', () => {
      it.each(['user', 'member'])(
        'refuses Google for the %s login, at the start and the callback',
        async (actor) => {
          for (const path of [
            `/auth/${actor}/google`,
            `/auth/${actor}/google/callback`,
          ]) {
            const res = await unwrapResponse(api.post(path, {}));
            expect(res.status).toBe(400);
            expect(res.data.message).toMatch(NOT_ALLOWED);
          }
        },
      );

      it('keeps the password login for staff', async () => {
        const res = await unwrapResponse(
          api.post('/auth/user/emailpass', {
            email: 'nobody@test.dev',
            password: 'wrong-password-1',
          }),
        );
        expect(res.status).toBe(401);
        expect(String(res.data?.message)).not.toMatch(/not allowed/);
      });

      it('still starts a Google sign-in for customers', async () => {
        const res = await unwrapResponse(api.post('/auth/customer/google', {}));
        expect(res.status).toBe(200);
        expect(res.data.location).toMatch(
          /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/,
        );
      });
    });
  },
});
