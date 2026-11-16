import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import type { ExecArgs } from '@medusajs/framework/types';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import deployBootstrap from '../../src/scripts/deploy-bootstrap';
import { VIP_LEVELS_SEED } from '../../src/scripts/vip-levels.data';

jest.setTimeout(240 * 1000);

const EMAIL = 'deploy-bootstrap-admin@test.dev';

// The migrate job's single post-migration `medusa exec`: create-admin then the
// VIP ladder seed. First run creates both, second run skips both, and a
// missing ADMIN_PASSWORD still seeds VIP (as the old two-exec chain did).
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ getContainer }) => {
    describe('deploy-bootstrap script', () => {
      const saved = {
        email: process.env.ADMIN_EMAIL,
        password: process.env.ADMIN_PASSWORD,
      };
      afterEach(() => {
        const restore = (k: string, v: string | undefined) =>
          v === undefined ? delete process.env[k] : (process.env[k] = v);
        restore('ADMIN_EMAIL', saved.email);
        restore('ADMIN_PASSWORD', saved.password);
      });

      const state = async (email = EMAIL) => {
        const c = getContainer();
        const users = await c.resolve(Modules.USER).listUsers({ email });
        const identities = await c
          .resolve(Modules.AUTH)
          .listProviderIdentities(
            { entity_id: email, provider: 'emailpass' },
            { relations: ['auth_identity'] },
          );
        const vip = await c
          .resolve<PacksModuleService>(PACKS_MODULE)
          .listVipLevels({}, { select: ['level'] });
        return { users, identities, vipCount: vip.length };
      };

      // Start from an empty ladder so the first run takes the create path even
      // if a migration ever pre-seeds it.
      const clearVip = async () => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const rows = await packs.listVipLevels({}, { select: ['id'] });
        if (rows.length) await packs.deleteVipLevels(rows.map((r) => r.id));
      };

      it('creates admin + VIP ladder on first run, skips both on second', async () => {
        process.env.ADMIN_EMAIL = EMAIL;
        process.env.ADMIN_PASSWORD = 'deploy-bootstrap-pw-1';
        await clearVip();
        const container = getContainer();
        const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
        const info = jest.spyOn(logger, 'info');

        await deployBootstrap({ container, args: [] } as unknown as ExecArgs);
        const first = await state();
        expect(first.users).toHaveLength(1);
        expect(first.identities).toHaveLength(1);
        expect(first.identities[0].auth_identity?.app_metadata?.user_id).toBe(
          first.users[0].id,
        );
        expect(first.vipCount).toBe(VIP_LEVELS_SEED.length);
        const firstLogs = info.mock.calls.map((c) => String(c[0]));
        expect(firstLogs.some((m) => m.startsWith(`ADMIN: created ${EMAIL}`))).toBe(true);
        expect(firstLogs).toContain(`Seeded ${VIP_LEVELS_SEED.length} VIP levels.`);

        info.mockClear();
        await deployBootstrap({ container, args: [] } as unknown as ExecArgs);
        const second = await state();
        expect(second.users.map((u) => u.id)).toEqual(first.users.map((u) => u.id));
        expect(second.identities).toHaveLength(1);
        expect(second.vipCount).toBe(VIP_LEVELS_SEED.length);
        const secondLogs = info.mock.calls.map((c) => String(c[0]));
        expect(secondLogs).toContain(
          `ADMIN: ${EMAIL} already exists (id=${first.users[0].id}) — skipping`,
        );
        expect(secondLogs).toContain('VIP levels already exist, skipping.');
        info.mockRestore();
      });

      it('still seeds VIP when ADMIN_PASSWORD is unset', async () => {
        // Own email: the assertion must not depend on the runner wiping the
        // previous test's admin between tests.
        const email = 'deploy-bootstrap-nopw@test.dev';
        process.env.ADMIN_EMAIL = email;
        delete process.env.ADMIN_PASSWORD;
        await clearVip();

        await deployBootstrap({ container: getContainer(), args: [] } as unknown as ExecArgs);
        const s = await state(email);
        expect(s.users).toHaveLength(0);
        expect(s.vipCount).toBe(VIP_LEVELS_SEED.length);
      });
    });
  },
});
