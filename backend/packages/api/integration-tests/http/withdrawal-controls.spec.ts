import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Admin withdrawal controls (2026-10-17): the Withdraw and Touch 'n Go
// switches, their daily schedules and the TNG minimum, stored on
// site_settings.withdrawal_controls (Migration20261017180000) and audited as
// site_settings / edit_site_settings. Runs against the migrated schema, so it
// also proves the column exists and the audit CHECKs accept the edit.
// Off until two days from now (whole minute, as the admin form sends it).
const OFF_UNTIL = new Date(
  Math.ceil((Date.now() + 2 * 86_400_000) / 60_000) * 60_000,
).toISOString();
const CLOSED = {
  withdrawals: {
    open: false,
    off_until: OFF_UNTIL,
    schedule: { on: true, close_at: '00:00', reopen_at: '06:00' },
  },
  tng: {
    open: true,
    off_until: null,
    schedule: { on: false, close_at: null, reopen_at: null },
    min_rm: 150,
  },
};

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('/admin/payments/withdrawal-controls', () => {
      let adminHeaders: Record<string, string>;
      let storeHeaders: Record<string, string>;

      beforeEach(async () => {
        const container = getContainer();
        const token = await mintSuperAdmin(
          container,
          api,
          'wc-admin@test.dev',
          'wc-test-password-1',
        );
        adminHeaders = { authorization: `Bearer ${token}` };
        const key = await container.resolve(Modules.API_KEY).createApiKeys({
          title: 'withdrawal-controls-test',
          type: 'publishable',
          created_by: 'withdrawal-controls-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
      });

      it('reads everything open before any edit', async () => {
        const res = await unwrapResponse(
          api.get('/admin/payments/withdrawal-controls', {
            headers: adminHeaders,
          }),
        );
        expect(res.status).toBe(200);
        expect(res.data.controls.withdrawals.open).toBe(true);
        expect(res.data.controls.tng).toMatchObject({
          open: true,
          min_rm: null,
        });
        expect(res.data.status.withdrawals).toEqual({
          open: true,
          reopens_at: null,
        });
        expect(res.data.tng_min_floor_rm).toBe(100);
      });

      it('refuses an edit without a reason and writes nothing', async () => {
        const res = await unwrapResponse(
          api.post('/admin/payments/withdrawal-controls', CLOSED, {
            headers: adminHeaders,
          }),
        );
        expect(res.status).toBe(400);
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        expect((await packs.withdrawalControls()).withdrawals.open).toBe(true);
      });

      it('saves, audits, and closes the storefront Withdraw button', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/payments/withdrawal-controls',
            { ...CLOSED, reason: 'payout provider maintenance' },
            { headers: adminHeaders },
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data.controls).toEqual(CLOSED);
        // Reopens at off_until, or at the end of the daily window it lands in.
        const reopensAt = res.data.status.withdrawals.reopens_at as string;
        expect(res.data.status.withdrawals.open).toBe(false);
        expect(Date.parse(reopensAt)).toBeGreaterThanOrEqual(
          Date.parse(OFF_UNTIL),
        );

        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        expect(await packs.withdrawalControls()).toEqual(CLOSED);
        const [audit] = await packs.listAdminActionAudits(
          { entity_type: 'site_settings', action: 'edit_site_settings' },
          { take: 1, order: { created_at: 'DESC' } },
        );
        expect(audit).toMatchObject({
          reason: 'payout provider maintenance',
          after: { withdrawal_controls: CLOSED },
        });

        const config = await unwrapResponse(
          api.get('/store/payments/config', { headers: storeHeaders }),
        );
        expect(config.status).toBe(200);
        expect(config.data.withdrawals_unavailable).toBe(true);
        expect(config.data.withdrawals_enabled).toBe(false);
        // The storefront popup names the same reopen instant.
        expect(config.data.withdrawals_paused_until).toBe(reopensAt);
      });
    });
  },
});
