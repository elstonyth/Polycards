// Test-only seed secret: publish and draw refuse without one (later tasks).
process.env.LUCKY_DRAW_SEED_SECRET ??= 'test-lucky-draw-seed-secret';

import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';

jest.setTimeout(240 * 1000);

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('Lucky Draw', () => {
      it('migrations create the lucky draw tables and task tickets column', async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const [ev] = await packs.createLuckyDrawEvents([
          {
            name: 'Nov',
            starts_at: new Date(),
            ends_at: new Date(Date.now() + 86400e3),
            created_by: 'user_t',
          },
        ]);
        expect(ev.status).toBe('draft');
        const [t] = await packs.createTaskDefinitions([
          {
            kind: 'daily',
            title: 'x',
            requirement: { type: 'checkin_days', days: 1 },
            reward: { type: 'credit', amount_myr: 1 },
          },
        ]);
        expect(t.tickets).toBe(0);
      });
    });
  },
});
