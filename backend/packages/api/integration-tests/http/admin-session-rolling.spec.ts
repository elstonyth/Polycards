import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { mintSuperAdmin } from './utils';

jest.setTimeout(240 * 1000);

// medusa-config sessionOptions.rolling (2026-10-30): an admin session renews
// on every request, so its 10-hour maxAge counts from the last use, not from
// sign-in. express-session shows it as a fresh Set-Cookie on EVERY response —
// without rolling, only the sign-in response sets the cookie and the login
// dies 10 hours after sign-in however busy the admin is.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    it('renews the admin session cookie on every request', async () => {
      const token = await mintSuperAdmin(
        getContainer(),
        api,
        'session-rolling@test.dev',
        'admin-pass-1',
      );
      const signIn = await api.post(
        '/auth/session',
        {},
        { headers: { authorization: `Bearer ${token}` } },
      );
      const cookie = (signIn.headers['set-cookie'] ?? [])
        .map((c: string) => c.split(';')[0])
        .find((c: string) => c.startsWith('connect.sid='));
      expect(cookie).toBeDefined();

      const later = await api.get('/admin/users/me', {
        headers: { cookie },
      });
      expect(later.status).toBe(200);
      const renewed = (later.headers['set-cookie'] ?? []).find((c: string) =>
        c.startsWith('connect.sid='),
      );
      expect(renewed).toMatch(/Expires=/);
    });
  },
});
