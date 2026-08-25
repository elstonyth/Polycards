import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'admin-rewards-settings-test-pw-1';
const ADMIN_EMAIL = 'admin-rewards-settings@test.dev';

// withdrawals_per_day is the only setting this endpoint still carries — the
// commission knobs (cooldown / team-override pct / generation cap) left with
// the referral programme (ADR 0007). The auth guard, the validation posture and
// the audited upsert are unchanged, so they are still exercised here.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET + POST /admin/rewards-settings', () => {
      let adminToken: string;

      beforeEach(async () => {
        const container = getContainer();
        adminToken = await mintSuperAdmin(
          container,
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
      });

      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      // ------------------------------------------------------------------ auth guard

      it('GET /admin/rewards-settings → 401 without auth', async () => {
        const res = await unwrapResponse(api.get('/admin/rewards-settings'));
        expect(res.status).toBe(401);
      });

      it('POST /admin/rewards-settings → 401 without auth', async () => {
        const res = await unwrapResponse(
          api.post('/admin/rewards-settings', {
            withdrawals_per_day: 2,
            reason: 'tune',
          }),
        );
        expect(res.status).toBe(401);
      });

      // ------------------------------------------------------------------ GET

      it('GET /admin/rewards-settings → 200 with defaults when no DB row', async () => {
        const res = await unwrapResponse(
          api.get('/admin/rewards-settings', { headers: adminHeaders() }),
        );
        expect(res.status).toBe(200);
        expect(res.data).toMatchObject({
          withdrawals_per_day: expect.any(Number),
        });
      });

      // ------------------------------------------------------------------ POST validation

      it('POST → 400 when withdrawals_per_day is 0', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/rewards-settings',
            { withdrawals_per_day: 0, reason: 'x' },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(400);
      });

      it('POST → 400 when withdrawals_per_day is fractional', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/rewards-settings',
            { withdrawals_per_day: 1.5, reason: 'x' },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(400);
      });

      it('POST → 400 when reason is missing', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/rewards-settings',
            { withdrawals_per_day: 2 },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(400);
      });

      it('POST → 400 when reason is blank', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/rewards-settings',
            { withdrawals_per_day: 2, reason: '   ' },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(400);
      });

      it('POST → 400 when patch is empty (no recognised fields)', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/rewards-settings',
            { reason: 'tune' },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(400);
      });

      // ------------------------------------------------------------------ POST happy path

      it('POST valid patch → 200, view reflects new value, GET also reflects it, audit row written', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);

        const postRes = await unwrapResponse(
          api.post(
            '/admin/rewards-settings',
            { withdrawals_per_day: 3, reason: 'tune for test' },
            { headers: adminHeaders() },
          ),
        );
        expect(postRes.status).toBe(200);
        expect(postRes.data.withdrawals_per_day).toBe(3);

        // GET must now reflect the new value
        const getRes = await unwrapResponse(
          api.get('/admin/rewards-settings', { headers: adminHeaders() }),
        );
        expect(getRes.status).toBe(200);
        expect(getRes.data.withdrawals_per_day).toBe(3);

        // Audit row must exist with correct action + admin_id from session
        const [aud] = await packs.listAdminActionAudits(
          { entity_type: 'rewards_settings', action: 'edit_rewards_settings' },
          { take: 1 },
        );
        expect(aud).toBeDefined();
        expect(aud.reason).toBe('tune for test');
        // admin_id comes from the session token, not the body — must be non-empty
        expect(typeof aud.admin_id).toBe('string');
        expect(aud.admin_id.length).toBeGreaterThan(0);
      });

      it('POST a second patch (upsert) → row is updated, second audit row written', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);

        await unwrapResponse(
          api.post(
            '/admin/rewards-settings',
            { withdrawals_per_day: 4, reason: 'first' },
            { headers: adminHeaders() },
          ),
        );

        const res = await unwrapResponse(
          api.post(
            '/admin/rewards-settings',
            { withdrawals_per_day: 5, reason: 'second' },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data.withdrawals_per_day).toBe(5);

        // Two audit rows total
        const rows = await packs.listAdminActionAudits(
          { entity_type: 'rewards_settings', action: 'edit_rewards_settings' },
          {},
        );
        expect(rows.length).toBeGreaterThanOrEqual(2);
      });
    });
  },
});
