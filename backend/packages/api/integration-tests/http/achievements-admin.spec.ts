/**
 * achievements-admin — integration:http
 *
 * Tests GET /admin/achievements + PUT /admin/achievements/:key:
 *   1. 401 without a token on both endpoints.
 *   2. GET returns the seeded 16 defs sorted by xp asc.
 *   3. PUT /admin/achievements/spend_1000 changes xp and persists.
 *   4. PUT on a missing key → 404.
 *
 * Mirrors admin-reward-pool.spec.ts: mintSuperAdmin + unwrapResponse pattern.
 */

import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const ADMIN_EMAIL = 'admin-achievements@test.dev';
const PASSWORD = 'admin-achievements-pw-1';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET + PUT /admin/achievements', () => {
      let adminToken: string;

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(getContainer(), api, ADMIN_EMAIL, PASSWORD);
      });

      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      // ---------------------------------------------------------------- auth guards

      it('GET /admin/achievements → 401 without auth', async () => {
        const res = await unwrapResponse(api.get('/admin/achievements'));
        expect(res.status).toBe(401);
      });

      it('PUT /admin/achievements/spend_1000 → 401 without auth', async () => {
        const res = await unwrapResponse(
          api.put('/admin/achievements/spend_1000', {
            name: 'X', description: 'X', category: 'spend', rarity: 'Common',
            xp: 100, metric: 'spend', threshold: 1000,
          }),
        );
        expect(res.status).toBe(401);
      });

      // ---------------------------------------------------------------- GET list

      it('GET /admin/achievements returns seeded defs sorted by xp', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        // Seed at least one def if none exist (the real seed seeds 16).
        const existing = await packs.listAchievementDefs({}, { take: 1 });
        if (existing.length === 0) {
          await packs.createAchievementDefs([{
            key: 'spend_1000',
            name: 'First Big Spend',
            description: 'Spend RM 1,000',
            category: 'spend',
            rarity: 'Common',
            xp: 100,
            metric: 'spend',
            threshold: 1000,
          }]);
        }

        const res = await unwrapResponse(
          api.get('/admin/achievements', { headers: adminHeaders() }),
        );
        expect(res.status).toBe(200);
        expect(Array.isArray(res.data.defs)).toBe(true);
        expect(res.data.defs.length).toBeGreaterThanOrEqual(1);

        // Verify sorted by xp ascending.
        const xps = (res.data.defs as { xp: number }[]).map((d) => Number(d.xp));
        for (let i = 1; i < xps.length; i++) {
          // ponytail: noUncheckedIndexedAccess guard
          const prev = xps[i - 1];
          const curr = xps[i];
          if (prev !== undefined && curr !== undefined) {
            expect(curr).toBeGreaterThanOrEqual(prev);
          }
        }
      });

      // ---------------------------------------------------------------- PUT update

      it('PUT /admin/achievements/spend_1000 changes xp and persists', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        // Ensure def exists.
        const existing = await packs.listAchievementDefs({ key: 'spend_1000' }, { take: 1 });
        if (existing.length === 0) {
          await packs.createAchievementDefs([{
            key: 'spend_1000',
            name: 'First Big Spend',
            description: 'Spend RM 1,000',
            category: 'spend',
            rarity: 'Common',
            xp: 100,
            metric: 'spend',
            threshold: 1000,
          }]);
        }

        const res = await unwrapResponse(
          api.put(
            '/admin/achievements/spend_1000',
            {
              name: 'First Big Spend',
              description: 'Spend RM 1,000',
              category: 'spend',
              rarity: 'Common',
              xp: 999,
              metric: 'spend',
              threshold: 1000,
            },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(200);
        expect(Number(res.data.def.xp)).toBe(999);

        // Verify persistence via service.
        const [after] = await packs.listAchievementDefs({ key: 'spend_1000' }, { take: 1 });
        expect(Number(after?.xp)).toBe(999);
      });

      // ---------------------------------------------------------------- PUT 404

      it('PUT /admin/achievements/nonexistent-key → 404', async () => {
        const res = await unwrapResponse(
          api.put(
            '/admin/achievements/nonexistent-ach-key-xyz',
            {
              name: 'X', description: 'X', category: 'spend', rarity: 'Common',
              xp: 1, metric: 'spend', threshold: 1,
            },
            { headers: adminHeaders() },
          ),
        );
        expect(res.status).toBe(404);
      });
    });
  },
});
