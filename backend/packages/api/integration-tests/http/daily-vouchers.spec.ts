import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { collapseLadder } from '../../src/modules/packs/voucher-ranges';
import { VIP_LEVELS } from '../../src/scripts/vip-levels.data';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'daily-vouchers-test-pw-1';
const ADMIN_EMAIL = 'daily-vouchers-admin@test.dev';
const BOX_TIERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'Z'];

// Task 6 — the /admin/daily-rewards surface:
//   - GET  /admin/daily-rewards/vouchers → 100-level ladder + collapsed ranges;
//   - POST /admin/daily-rewards/vouchers → saveVoucherRanges (fold errors → 400,
//     valid ranges rewrite vip_level.voucher_amount + ONE audit row);
//   - GET  /admin/daily-rewards/boxes → all 11 tiers with prize/customer counts
//     and the level range each tier serves (tier 'a' = 1–9, 'Z' = 100–100);
//   - GET/POST /admin/daily-rewards/boxes/:tier → editor read (locked+pct are
//     authoring-only fields, allowed HERE) / saveDailyBoxWorkflow write
//     (validation errors → 400, unknown tier → 404).
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('/admin/daily-rewards (boxes + vouchers)', () => {
      let adminToken: string;

      const packs = () =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);

      beforeEach(async () => {
        const container = getContainer();
        adminToken = await mintSuperAdmin(container, api, ADMIN_EMAIL, PASSWORD);

        // Re-ensure the script-seeded VIP ladder and the migration-seeded 11
        // reward_box rows (the between-test TRUNCATE wipes both).
        const svc = packs();
        if ((await svc.listVipLevels({}, { take: 1 })).length === 0) {
          await svc.createVipLevels(
            VIP_LEVELS.map((r) => ({
              level: r.level,
              spend_threshold: r.spend_threshold,
              voucher_amount: r.voucher_amount,
              box_tier: r.box_tier,
              frame_unlock: r.frame_unlock,
              prizes: r.prizes ?? null,
            })),
          );
        }
        const boxes = await svc.listRewardBoxes({}, { take: 100 });
        const have = new Set(boxes.map((b) => b.tier));
        const missing = BOX_TIERS.filter((t) => !have.has(t));
        if (missing.length > 0) {
          await svc.createRewardBoxes(
            missing.map((tier) => ({
              tier,
              name: '',
              enabled: false,
              draws_per_day: 1,
            })),
          );
        }
      });

      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      it('401s without an admin token', async () => {
        expect(
          (await unwrapResponse(api.get('/admin/daily-rewards/boxes'))).status,
        ).toBe(401);
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

      it("GET boxes: 11 tiers with counts and level ranges — 'a' serves 1–9, 'Z' serves 100–100", async () => {
        const res = await unwrapResponse(
          api.get('/admin/daily-rewards/boxes', { headers: adminHeaders() }),
        );
        expect(res.status).toBe(200);
        expect(res.data.boxes).toHaveLength(11);

        const byTier = new Map(
          (res.data.boxes as { tier: string }[]).map((b) => [b.tier, b]),
        );
        for (const tier of BOX_TIERS) {
          expect(byTier.has(tier)).toBe(true);
        }
        expect(byTier.get('a')).toMatchObject({
          level_from: 1,
          level_to: 9,
          enabled: false,
          prize_count: 0,
        });
        expect(byTier.get('Z')).toMatchObject({
          level_from: 100,
          level_to: 100,
        });
        for (const box of res.data.boxes as { customer_count: number }[]) {
          expect(box.customer_count).toBeGreaterThanOrEqual(0);
        }
      });

      it('boxes/:tier editor round-trip: POST saves (audit row), GET returns locked+pct authoring fields; unknown tier → 404', async () => {
        const post = await unwrapResponse(
          api.post(
            '/admin/daily-rewards/boxes/a',
            {
              name: 'Alpha Box',
              enabled: true,
              draws_per_day: 2,
              reason: 'authoring test',
              prizes: [
                { kind: 'credit', locked: false, pct: 0, amount_myr: 5 },
                { kind: 'voucher', locked: true, pct: 10, amount_myr: 50 },
              ],
            },
            { headers: adminHeaders() },
          ),
        );
        expect(post.status).toBe(200);
        expect(post.data).toMatchObject({
          tier: 'a',
          prize_count: 2,
          enabled: true,
          draws_per_day: 2,
        });

        const get = await unwrapResponse(
          api.get('/admin/daily-rewards/boxes/a', { headers: adminHeaders() }),
        );
        expect(get.status).toBe(200);
        expect(get.data.box).toEqual({
          tier: 'a',
          name: 'Alpha Box',
          enabled: true,
          draws_per_day: 2,
        });
        expect(get.data.prizes).toHaveLength(2);
        const locked = (
          get.data.prizes as { locked: boolean; pct: number; kind: string }[]
        ).find((p) => p.locked);
        expect(locked).toMatchObject({ kind: 'voucher', pct: 10 });
        const unlocked = (
          get.data.prizes as { locked: boolean; pct: number; kind: string }[]
        ).find((p) => !p.locked);
        expect(unlocked).toMatchObject({ kind: 'credit', pct: 90 });

        const audits = await packs().listAdminActionAudits(
          { action: 'edit_daily_box' },
          { take: 10 },
        );
        expect(audits).toHaveLength(1);
        expect(audits[0].reason).toBe('authoring test');

        const missing = await unwrapResponse(
          api.get('/admin/daily-rewards/boxes/zz', { headers: adminHeaders() }),
        );
        expect(missing.status).toBe(404);
      });

      it('POST boxes/:tier: over-ceiling credit → 400, box untouched', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/daily-rewards/boxes/a',
            {
              name: 'Too Rich Box',
              enabled: true,
              draws_per_day: 1,
              reason: 'ceiling test',
              prizes: [
                { kind: 'credit', locked: false, pct: 0, amount_myr: 10001 },
              ],
            },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(400);
        expect(String(res.data.message)).toMatch(/ceiling/i);

        // Nothing was written: the tier-'a' box is untouched, no prizes exist.
        const editor = await packs().getDailyBoxEditor('a');
        expect(editor.box).toMatchObject({ enabled: false, name: '' });
        expect(editor.prizes).toHaveLength(0);
        expect(
          await packs().listAdminActionAudits(
            { action: 'edit_daily_box' },
            { take: 10 },
          ),
        ).toHaveLength(0);
      });
    });
  },
});
