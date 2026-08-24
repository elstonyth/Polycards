import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { VIP_LEVELS } from '../../src/scripts/vip-levels.data';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'vip-levels-test-pw-1';
const ADMIN_EMAIL = 'vip-levels-admin@test.dev';
const BOX_TIERS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'Z'];

// A small valid ladder reused across POST cases: 3 contiguous rungs, rung 1
// threshold 0, strictly increasing, no frames (all non-decade), box_tier 'a'.
const smallLadder = () => [
  { level: 1, spend_threshold: 0, voucher_amount: 0, box_tier: 'a', frame_unlock: false },
  { level: 2, spend_threshold: 100, voucher_amount: 5, box_tier: 'a', frame_unlock: false },
  { level: 3, spend_threshold: 200, voucher_amount: 9, box_tier: 'a', frame_unlock: false },
];

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('/admin/vip-levels', () => {
      let adminToken: string;
      const packs = () =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);
      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      beforeEach(async () => {
        const container = getContainer();
        adminToken = await mintSuperAdmin(container, api, ADMIN_EMAIL, PASSWORD);
        const svc = packs();
        // Re-seed the ladder + the 11 reward_box rows (TRUNCATE wipes both).
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
            missing.map((tier) => ({ tier, name: '', enabled: false, draws_per_day: 1 })),
          );
        }
      });

      it('401s without an admin token', async () => {
        expect((await unwrapResponse(api.get('/admin/vip-levels'))).status).toBe(401);
        expect(
          (
            await unwrapResponse(
              api.post('/admin/vip-levels', { levels: smallLadder(), reason: 'x' }),
            )
          ).status,
        ).toBe(401);
      });

      it('GET returns the seeded ladder ordered by level', async () => {
        const res = await unwrapResponse(
          api.get('/admin/vip-levels', { headers: adminHeaders() }),
        );
        expect(res.status).toBe(200);
        expect(res.data.levels).toHaveLength(VIP_LEVELS.length);
        expect(res.data.levels[0]).toMatchObject({ level: 1, spend_threshold: 0 });
        for (let i = 1; i < res.data.levels.length; i++) {
          expect(res.data.levels[i].level).toBe(res.data.levels[i - 1].level + 1);
        }
      });

      it('POST replaces the ladder and writes one audit row', async () => {
        const res = await unwrapResponse(
          api.post(
            '/admin/vip-levels',
            { levels: smallLadder(), reason: 'shrink to 3' },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(200);
        expect(res.data.levels).toHaveLength(3);

        const rows = await packs().listVipLevels({}, { take: 1000 });
        expect(rows).toHaveLength(3);

        const audits = await packs().listAdminActionAudits(
          { entity_type: 'vip_levels', action: 'replace' },
          { take: 10 },
        );
        expect(audits).toHaveLength(1);
        expect(audits[0].reason).toBe('shrink to 3');
        expect(audits[0].admin_id.length).toBeGreaterThan(0);
      });

      it('POST invariant violation → 400, ladder unchanged (atomicity)', async () => {
        const before = await packs().listVipLevels({}, { take: 1000 });
        const res = await unwrapResponse(
          api.post(
            '/admin/vip-levels',
            {
              levels: [
                { level: 1, spend_threshold: 5, voucher_amount: 0, box_tier: 'a', frame_unlock: false },
              ],
              reason: 'bad first threshold',
            },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(400);
        expect(String(res.data.message)).toMatch(/spend_threshold must be 0/);
        expect(await packs().listVipLevels({}, { take: 1000 })).toHaveLength(
          before.length,
        );
      });

      it('POST unknown box_tier → 400', async () => {
        const bad = smallLadder().map((r) => ({ ...r, box_tier: 'zz' }));
        const res = await unwrapResponse(
          api.post(
            '/admin/vip-levels',
            { levels: bad, reason: 'bad tier' },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(400);
        expect(String(res.data.message)).toMatch(/not an existing reward box tier/);
      });

      it('replace → shrink → save again succeeds (no soft-delete unique collision on level)', async () => {
        await unwrapResponse(
          api.post(
            '/admin/vip-levels',
            { levels: smallLadder(), reason: 'first save (3 rungs)' },
            { headers: adminHeaders() },
          ),
        );
        const two = smallLadder().slice(0, 2);
        const shrink = await unwrapResponse(
          api.post(
            '/admin/vip-levels',
            { levels: two, reason: 'shrink to 2' },
            { headers: adminHeaders() },
          ),
        );
        expect(shrink.status).toBe(200);
        // Recreate rung 3 — a soft-deleted level=3 would collide here.
        const grow = await unwrapResponse(
          api.post(
            '/admin/vip-levels',
            { levels: smallLadder(), reason: 'regrow to 3' },
            { headers: adminHeaders() },
          ),
        );
        expect(grow.status).toBe(200);
        expect((await packs().listVipLevels({}, { take: 1000 }))).toHaveLength(3);
      });

      it('clamps a member peaked above a shrunken ladder to the top rung (daily box keeps resolving)', async () => {
        // Shrink to 3 rungs; give the top rung a distinct tier to observe the clamp.
        const three = smallLadder();
        three[2].box_tier = 'b';
        const shrink = await unwrapResponse(
          api.post(
            '/admin/vip-levels',
            { levels: three, reason: 'shrink below member peak' },
            { headers: adminHeaders() },
          ),
        );
        expect(shrink.status).toBe(200);

        // Member whose monotonic peak (50) no longer has a vip_level row.
        await packs().createVipMemberStates([
          {
            customer_id: 'cus_clamp_test',
            lifetime_external_spend_sen: 0,
            highest_level_ever: 50,
            current_level: 3,
          },
        ]);
        const tier = await (
          packs() as unknown as {
            resolveBoxTier(id: string, ctx: object): Promise<string>;
          }
        ).resolveBoxTier('cus_clamp_test', {});
        expect(tier).toBe('b');
      });
    });
  },
});
