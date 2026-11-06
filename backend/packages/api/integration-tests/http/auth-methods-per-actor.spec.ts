import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Staff sign in with a password only (security audit 2026-11-07). With no
// allowlist Medusa lets every registered provider serve every actor, so
// Google, there for customers, also served the admin and seller logins: POST
// /auth/google/user then created an admin from any Google account, or signed
// a staff member in through the Google account of their email, without the
// admin password. medusa-config's http.authMethodsPerActor is the allowlist.
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

      it('still lets customers start a Google sign-in', async () => {
        const res = await unwrapResponse(api.post('/auth/customer/google', {}));
        expect(String(res.data?.message)).not.toMatch(NOT_ALLOWED);
      });
    });
  },
});
