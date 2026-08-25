import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { collapseLadder } from '../../src/modules/packs/voucher-ranges';
import { VIP_LEVELS } from '../../src/scripts/vip-levels.data';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'daily-vouchers-test-pw-1';
const ADMIN_EMAIL = 'daily-vouchers-admin@test.dev';

// Task 6 — the /admin/daily-rewards surface (the boxes half was removed with
// the daily box, 2026-08-25):
//   - GET  /admin/daily-rewards/vouchers → 100-level ladder + collapsed ranges;
//   - POST /admin/daily-rewards/vouchers → saveVoucherRanges (fold errors → 400,
//     valid ranges rewrite vip_level.voucher_amount + ONE audit row).
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('/admin/daily-rewards (vouchers)', () => {
      let adminToken: string;

      const packs = () =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);

      beforeEach(async () => {
        const container = getContainer();
        adminToken = await mintSuperAdmin(container, api, ADMIN_EMAIL, PASSWORD);

        // Re-ensure the script-seeded VIP ladder (the between-test TRUNCATE
        // wipes it).
        const svc = packs();
        if ((await svc.listVipLevels({}, { take: 1 })).length === 0) {
          await svc.createVipLevels(
            VIP_LEVELS.map((r) => ({
              level: r.level,
              spend_threshold: r.spend_threshold,
              voucher_amount: r.voucher_amount,
              frame_unlock: r.frame_unlock,
              prizes: r.prizes ?? null,
            })),
          );
        }
      });

      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      it('401s without an admin token', async () => {
        expect(
          (
            await unwrapResponse(
              api.post('/admin/daily-rewards/vouchers', {
                ranges: [{ from: 1, to: 100, amount_myr: 1 }],
                reason: 'nope',
              }),
            )
          ).status,
        ).toBe(401);
      });

      it('GET vouchers: 100 ladder levels + collapsed ranges matching the seed', async () => {
        const res = await unwrapResponse(
          api.get('/admin/daily-rewards/vouchers', { headers: adminHeaders() }),
        );
        expect(res.status).toBe(200);
        expect(res.data.levels).toHaveLength(100);
        expect(res.data.levels[0]).toEqual({ level: 1, amount_myr: 0 });
        // ranges are the exact collapse of the seeded per-level amounts.
        expect(res.data.ranges).toEqual(
          collapseLadder(VIP_LEVELS.map((l) => l.voucher_amount)),
        );
      });

      it('POST vouchers: valid ranges rewrite vip_level.voucher_amount and write one audit row', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/daily-rewards/vouchers',
            {
              ranges: [
                { from: 1, to: 50, amount_myr: 5 },
                { from: 51, to: 100, amount_myr: 9 },
              ],
              reason: 'integration test rewrite',
            },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(200);

        // Real DB effect, via the service: the ladder now folds to the ranges.
        const ladder = await packs().getVoucherLadder();
        expect(ladder).toHaveLength(100);
        expect(ladder[0]).toEqual({ level: 1, amount_myr: 5 });
        expect(ladder[49]).toEqual({ level: 50, amount_myr: 5 });
        expect(ladder[50]).toEqual({ level: 51, amount_myr: 9 });
        expect(ladder[99]).toEqual({ level: 100, amount_myr: 9 });

        const audits = await packs().listAdminActionAudits(
          { action: 'edit_voucher_ladder' },
          { take: 10 },
        );
        expect(audits).toHaveLength(1);
        expect(audits[0].reason).toBe('integration test rewrite');
        expect(audits[0].admin_id.length).toBeGreaterThan(0);
      });

      it('POST vouchers: overlapping ranges → 400, ladder untouched', async () => {
        const before = await packs().getVoucherLadder();
        const res = await unwrapResponse(
          api.post(
            '/admin/daily-rewards/vouchers',
            {
              ranges: [
                { from: 1, to: 60, amount_myr: 5 },
                { from: 50, to: 100, amount_myr: 9 },
              ],
              reason: 'overlap attempt',
            },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(400);
        expect(String(res.data.message)).toMatch(/overlap/i);
        expect(await packs().getVoucherLadder()).toEqual(before);
        expect(
          await packs().listAdminActionAudits(
            { action: 'edit_voucher_ladder' },
            { take: 10 },
          ),
        ).toHaveLength(0);
      });

    });
  },
});
