import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { unwrapResponse } from './utils';

jest.setTimeout(180 * 1000);

// SECURITY (audit 2026-07-15): the bundled @mercurjs/core plugin mounts a public
// vendor self-registration surface. Mercur's `seller_registration: false` flag is
// UI-visibility only and does NOT gate the API, so an anonymous user could
// POST /auth/member/emailpass/register → POST /vendor/sellers to create a real
// seller+store+membership in production. A repo middleware
// (src/api/middlewares.ts → blockUnusedSurface) hard-404s the two
// registration entrypoints. Since 2026-11-10 seller sign-in is closed as well
// (owner; security audit 2026-11-09 #11: no two-step code, no seller ever
// signed in). These tests assert the surface is closed WITHOUT over-blocking
// customer registration (the storefront).

const PASSWORD = 'vendor-block-pw-1';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api }) => {
    describe('Mercur vendor self-registration is blocked', () => {
      it('POST /auth/member/emailpass/register → 404 (member self-registration disabled)', async () => {
        const res = await unwrapResponse(
          api.post('/auth/member/emailpass/register', {
            email: 'attacker-member@example.com',
            password: PASSWORD,
          }),
        );
        expect(res.status).toBe(404);
      });

      it('POST /vendor/sellers → blocked, no seller self-created', async () => {
        const res = await unwrapResponse(
          api.post('/vendor/sellers', {
            name: 'Rogue Store',
            handle: 'rogue-store',
            member: { name: 'A', email: 'attacker-member@example.com' },
          }),
        );
        // Defense-in-depth check. A tokenless request 401s at Mercur's own
        // authenticate('member', { allowUnregistered: true }) — allowUnregistered
        // permits a token whose actor isn't yet a registered seller, NOT an
        // anonymous caller — so this path returns 401 whether or not the repo
        // block exists. It asserts only "never a 200/201 that created a seller";
        // the register→404 test above is what actually proves the block (an
        // attacker can't obtain a member token to reach /vendor/sellers once
        // /register is closed).
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect([401, 403, 404]).toContain(res.status);
      });

      it('POST /auth/customer/emailpass/register → 200 (customer registration NOT affected)', async () => {
        const res = await unwrapResponse(
          api.post('/auth/customer/emailpass/register', {
            email: 'legit-customer@example.com',
            password: PASSWORD,
          }),
        );
        expect(res.status).toBe(200);
        expect(res.data.token).toEqual(expect.any(String));
      });

      it('seller sign-in is closed: login, password reset and Google → 404', async () => {
        for (const [path, body] of [
          [
            '/auth/member/emailpass',
            { email: 'nobody-member@example.com', password: 'wrong-password' },
          ],
          ['/auth/member/emailpass/reset-password', { identifier: 'a@b.c' }],
          ['/auth/member/google', {}],
        ] as const) {
          const res = await unwrapResponse(api.post(path, body));
          expect({ path, status: res.status }).toEqual({ path, status: 404 });
        }
        const google = await unwrapResponse(api.get('/auth/member/google'));
        expect(google.status).toBe(404);
      });

      it('POST /auth/user/emailpass (staff login) is untouched by the seller block', async () => {
        const res = await unwrapResponse(
          api.post('/auth/user/emailpass', {
            email: 'nobody-staff@example.com',
            password: 'wrong-password',
          }),
        );
        expect([400, 401]).toContain(res.status);
      });
    });
  },
});
