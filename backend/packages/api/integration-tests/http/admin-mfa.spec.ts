import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { CLOCK_SLACK_MS } from '../../src/api/utils/admin-mfa-guard';
import { mintSuperAdmin, totpCode, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Admin two-step sign-in (owner, 2026-11-07): every admin login uses an
// authenticator app. A login without one reaches only its setup; with one, the
// password returns a code challenge whose token opens nothing but that code;
// backup codes work once each; a Super Admin can reset another admin.
const EMAIL = 'staff-2fa@test.dev';
const PASSWORD = 'staff-2fa-pw-1';
const STEP_MS = 30_000;
// Past the guard's clock allowance, so a sign-in reads as older than what
// follows it.
const pastSlack = () =>
  new Promise((r) => setTimeout(r, CLOCK_SLACK_MS + 1_000));

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    const bearer = (token: string) => ({
      headers: { authorization: `Bearer ${token}` },
    });
    const call = (
      method: 'get' | 'post',
      path: string,
      token: string,
      body?: unknown,
    ) =>
      unwrapResponse(
        method === 'get'
          ? api.get(path, bearer(token))
          : api.post(path, body ?? {}, bearer(token)),
      );

    // A Super Admin without an authenticator yet, as every admin is the day
    // this ships: created and linked the way mintSuperAdmin does, minus setup.
    const staffWithoutAuthenticator = async (): Promise<string> => {
      const container = getContainer();
      const rbac = container.resolve(Modules.RBAC) as unknown as {
        listRbacRoles: (f: { id: string }) => Promise<{ id: string }[]>;
      };
      const roles = await rbac.listRbacRoles({ id: 'role_super_admin' });
      const { result } = await container
        .resolve(Modules.WORKFLOW_ENGINE)
        .run('create-users-workflow', {
          input: { users: [{ email: EMAIL, roles: roles.map((r) => r.id) }] },
        });
      const auth = container.resolve(Modules.AUTH);
      const { authIdentity } = await auth.register('emailpass', {
        body: { email: EMAIL, password: PASSWORD },
      } as Parameters<typeof auth.register>[1]);
      await auth.updateAuthIdentities({
        id: authIdentity!.id,
        app_metadata: { user_id: (result as { id: string }[])[0].id },
      });
      return (result as { id: string }[])[0].id;
    };
    const signIn = () =>
      unwrapResponse(
        api.post('/auth/user/emailpass', { email: EMAIL, password: PASSWORD }),
      );
    // Sets up an authenticator through the admin's own routes; returns its
    // secret and backup codes.
    const setUp = async (token: string) => {
      const started = await call('post', '/auth/mfa/factors', token, {
        provider: 'totp',
      });
      expect(started.status).toBe(200);
      const secret = started.data.secret as string;
      const verified = await call(
        'post',
        `/auth/mfa/factors/${started.data.mfa_factor.id}/verify`,
        token,
        { code: totpCode(secret) },
      );
      expect(verified.status).toBe(200);
      expect(verified.data.mfa_factor.status).toBe('enabled');
      const codes = await call('post', '/auth/mfa/recovery-codes', token);
      expect(codes.status).toBe(200);
      return {
        secret,
        otpauthUrl: started.data.otpauth_url as string,
        backupCodes: codes.data.recovery_codes as string[],
      };
    };
    const answer = (
      challengeId: string,
      token: string,
      method: string,
      code: string,
    ) =>
      call('post', `/auth/mfa/challenges/${challengeId}/verify`, token, {
        method,
        code,
      });

    describe('admin two-step sign-in', () => {
      it('lets a login without an authenticator reach only its setup, then asks for the code at every sign-in', async () => {
        await staffWithoutAuthenticator();
        const first = await signIn();
        expect(first.status).toBe(200);
        expect(first.data.mfa_required).toBeUndefined();
        const before = await call('get', '/admin/users/me', first.data.token);
        expect(before.status).toBe(403);
        expect(before.data.type).toBe('mfa_setup_required');

        await pastSlack();
        const { secret, otpauthUrl, backupCodes } = await setUp(
          first.data.token,
        );
        // What the phone app reads from the QR code.
        const url = new URL(otpauthUrl);
        expect(url.protocol).toBe('otpauth:');
        expect(url.host).toBe('totp');
        expect(decodeURIComponent(url.pathname)).toContain(EMAIL);
        expect(url.searchParams.get('issuer')).toBe('Polycards Admin');
        expect(url.searchParams.get('secret')).toBe(secret);
        expect(url.searchParams.get('algorithm')?.toUpperCase() ?? 'SHA1').toBe(
          'SHA1',
        );
        expect(url.searchParams.get('digits') ?? '6').toBe('6');
        expect(url.searchParams.get('period') ?? '30').toBe('30');
        expect(backupCodes).toHaveLength(10);
        // The sign-in that set it up never answered a code: it must sign in
        // again, with one.
        const stale = await call('get', '/admin/users/me', first.data.token);
        expect(stale.status).toBe(401);
        expect(stale.data.type).toBe('mfa_sign_in_required');
        // Nor can it be refreshed into a token that would pass.
        const refreshedStale = await call(
          'post',
          '/auth/token/refresh',
          first.data.token,
        );
        expect(refreshedStale.status).toBe(401);
        expect(refreshedStale.data.type).toBe('mfa_sign_in_required');

        // One authenticator per login.
        const second = await call(
          'post',
          '/auth/mfa/factors',
          first.data.token,
          {
            provider: 'totp',
          },
        );
        expect(second.status).toBe(409);

        // The next sign-in: the password alone opens nothing but the code.
        const next = await signIn();
        expect(next.status).toBe(200);
        expect(next.data.mfa_required).toBe(true);
        const half = next.data.token as string;
        const challenge = next.data.mfa_challenge.id as string;
        expect((await call('get', '/admin/users/me', half)).status).toBe(401);
        for (const [path, body] of [
          ['/auth/mfa/factors', { provider: 'totp' }],
          ['/auth/mfa/recovery-codes', {}],
        ] as const) {
          const res = await call('post', path, half, body);
          expect({ path, status: res.status }).toEqual({ path, status: 401 });
        }
        const refreshed = await call('post', '/auth/token/refresh', half);
        expect(refreshed.data.mfa_required ?? false).toBe(true);
        expect(
          (await answer(challenge, half, 'totp', '000000')).status,
        ).not.toBe(200);
        const passed = await answer(challenge, half, 'totp', totpCode(secret));
        expect(passed.status).toBe(200);
        expect(
          (await call('get', '/admin/users/me', passed.data.token)).status,
        ).toBe(200);
        // Backup codes are made once, at setup.
        expect(
          (await call('post', '/auth/mfa/recovery-codes', passed.data.token))
            .status,
        ).toBe(409);

        // A code from the step before or after still counts (clock drift);
        // one from two minutes ago does not.
        const late = await signIn();
        expect(
          (
            await answer(
              late.data.mfa_challenge.id,
              late.data.token,
              'totp',
              totpCode(secret, Date.now() - 4 * STEP_MS),
            )
          ).status,
        ).not.toBe(200);
        const drift = await signIn();
        expect(
          (
            await answer(
              drift.data.mfa_challenge.id,
              drift.data.token,
              'totp',
              totpCode(secret, Date.now() - STEP_MS),
            )
          ).status,
        ).toBe(200);

        // A backup code instead of the app, once.
        const lost = await signIn();
        const withBackup = await answer(
          lost.data.mfa_challenge.id,
          lost.data.token,
          'recovery_code',
          backupCodes[0],
        );
        expect(withBackup.status).toBe(200);
        expect(
          (await call('get', '/admin/users/me', withBackup.data.token)).status,
        ).toBe(200);
        const again = await signIn();
        expect(
          (
            await answer(
              again.data.mfa_challenge.id,
              again.data.token,
              'recovery_code',
              backupCodes[0],
            )
          ).status,
        ).not.toBe(200);
      });

      it('lets a new setup replace an unfinished one (a reload mid-setup)', async () => {
        await staffWithoutAuthenticator();
        const token = (await signIn()).data.token as string;
        const start = () =>
          call('post', '/auth/mfa/factors', token, { provider: 'totp' });
        const first = await start();
        expect(first.status).toBe(200);
        // Medusa alone refuses this while the first is pending (Yuan,
        // 2026-11-07); the guard clears the unfinished one instead.
        const second = await start();
        expect(second.status).toBe(200);
        expect(second.data.secret).not.toBe(first.data.secret);
        const stale = await call(
          'post',
          `/auth/mfa/factors/${first.data.mfa_factor.id}/verify`,
          token,
          { code: totpCode(first.data.secret) },
        );
        expect(stale.status).toBe(404);
        const confirmed = await call(
          'post',
          `/auth/mfa/factors/${second.data.mfa_factor.id}/verify`,
          token,
          { code: totpCode(second.data.secret) },
        );
        expect(confirmed.status).toBe(200);
        // Clearing an unfinished setup is no reset: the same sign-in still
        // makes its backup codes, and a third start meets the confirmed one.
        expect(
          (await call('post', '/auth/mfa/recovery-codes', token)).status,
        ).toBe(200);
        expect((await start()).status).toBe(409);
      });

      it('gives up on a challenge after five wrong codes', async () => {
        await staffWithoutAuthenticator();
        const { secret } = await setUp((await signIn()).data.token);
        const login = await signIn();
        for (let i = 0; i < 5; i += 1) {
          await answer(
            login.data.mfa_challenge.id,
            login.data.token,
            'totp',
            '000000',
          );
        }
        const right = await answer(
          login.data.mfa_challenge.id,
          login.data.token,
          'totp',
          totpCode(secret),
        );
        expect(right.status).not.toBe(200);
      });

      it('keeps customers off two-step setup', async () => {
        const auth = getContainer().resolve(Modules.AUTH);
        await auth.register('emailpass', {
          body: { email: 'shopper-2fa@test.dev', password: 'shopper-pw-1' },
        } as Parameters<typeof auth.register>[1]);
        const shopper = await unwrapResponse(
          api.post('/auth/customer/emailpass', {
            email: 'shopper-2fa@test.dev',
            password: 'shopper-pw-1',
          }),
        );
        expect(shopper.status).toBe(200);
        const res = await call(
          'post',
          '/auth/mfa/factors',
          shopper.data.token,
          {
            provider: 'totp',
          },
        );
        expect(res.status).toBe(401);
      });

      it("lets a Super Admin reset another admin's two-step sign-in, audited", async () => {
        const userId = await staffWithoutAuthenticator();
        const token = (await signIn()).data.token as string;
        await setUp(token);
        await pastSlack();

        const owner = await mintSuperAdmin(
          getContainer(),
          api,
          'owner-2fa@test.dev',
          'owner-2fa-pw-1',
        );
        const reset = await call(
          'post',
          `/admin/users/${userId}/mfa/reset`,
          owner,
        );
        expect(reset.status).toBe(200);
        expect(reset.data).toEqual({
          user_id: userId,
          authenticators_removed: 1,
          backup_codes_removed: 10,
        });
        // Their next admin request asks them to set up again; the next
        // sign-in no longer asks for a code.
        expect((await call('get', '/admin/users/me', token)).data.type).toBe(
          'mfa_setup_required',
        );
        // Only a sign-in made since the reset sets up the new authenticator.
        expect(
          (await call('post', '/auth/mfa/factors', token, { provider: 'totp' }))
            .status,
        ).toBe(401);
        const fresh = await signIn();
        expect(fresh.data.mfa_required).toBeUndefined();
        expect(
          (
            await call('post', '/auth/mfa/factors', fresh.data.token, {
              provider: 'totp',
            })
          ).status,
        ).toBe(200);

        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [row] = await packs.listAdminActionAudits({
          entity_type: 'admin_user',
          entity_id: userId,
        });
        expect(row).toMatchObject({
          action: 'reset_mfa',
          before: { authenticators: 1, backup_codes: 10 },
          after: { authenticators: 0, backup_codes: 0 },
        });
        expect(
          (await call('post', '/admin/users/user_missing/mfa/reset', owner))
            .status,
        ).toBe(404);
      });
    });
  },
});
