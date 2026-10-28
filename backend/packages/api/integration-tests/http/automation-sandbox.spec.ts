import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { tickSandbox } from '../../src/api/utils/automation-sandbox-store';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240_000);

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('isolated cloud Automation sandbox', () => {
      it('persists settings, serializes ticks and controls, and never changes customer ledgers', async () => {
        const container = getContainer();
        const token = await mintSuperAdmin(
          container,
          api,
          'sandbox-admin@example.test',
          'sandbox-test-password',
        );
        const headers = { authorization: `Bearer ${token}` };
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        const customers = container.resolve(Modules.CUSTOMER);
        const [customer] = await customers.createCustomers([
          { email: 'sandbox-canary@example.test', has_account: true },
        ]);
        await packs.createCreditTransactions([
          { customer_id: customer.id, amount: 123.45, reason: 'topup' },
        ]);
        const ledgerBefore = await packs.listCreditTransactions({
          customer_id: customer.id,
        });
        const pullsBefore = await packs.listAndCountPulls({});
        const customerCount = (await customers.listAndCountCustomers({}))[1];
        expect(
          (await unwrapResponse(api.get('/admin/automation/sandbox'))).status,
        ).toBe(401);
        expect(
          (await api.get('/admin/automation/sandbox', { headers })).data
            .profiles,
        ).toEqual([]);
        const created = await api.post(
          '/admin/automation/sandbox',
          { action: 'create_profiles', count: 80 },
          { headers },
        );
        const ids = created.data.profiles.map(
          (profile: { id: string }) => profile.id,
        );
        expect(ids).toHaveLength(80);
        expect(ids.every((id: string) => id.startsWith('sandbox_'))).toBe(true);
        const config = {
          ...created.data.config,
          maxCyclesPerProfile: 2,
          maxTotalSpend: 1600,
        };
        await api.post(
          '/admin/automation/sandbox',
          { action: 'save', config, profileIds: ids },
          { headers },
        );
        expect(
          (await api.get('/admin/automation/sandbox', { headers })).data.config
            .maxCyclesPerProfile,
        ).toBe(2);
        await api.post(
          '/admin/automation/sandbox',
          { action: 'bonus', amount: 15.25, profileIds: ids },
          { headers },
        );
        expect(
          (
            await unwrapResponse(
              api.post(
                '/admin/automation/sandbox',
                {
                  action: 'run',
                  config,
                  profileIds: [customer.id],
                },
                { headers },
              ),
            )
          ).status,
        ).toBe(400);
        expect(
          (
            await unwrapResponse(
              api.post(
                '/admin/automation/sandbox',
                {
                  action: 'create_profiles',
                  count: 1,
                  credentials: 'never-store',
                },
                { headers },
              ),
            )
          ).status,
        ).toBe(400);
        await api.post(
          '/admin/automation/sandbox',
          { action: 'run', config, profileIds: ids },
          { headers },
        );
        const clock = Date.now() + 2000;
        await Promise.all([
          tickSandbox(container, clock),
          tickSandbox(container, clock),
          tickSandbox(container, clock),
        ]);
        let view = (await api.get('/admin/automation/sandbox', { headers }))
          .data;
        expect(view.completedCycles).toBe(1);
        expect(view.results[0].cycles[0].differenceCents).toBe(0);
        expect(view.results[0].cycles[0].bonusDifferenceCents).toBe(0);
        await api.post(
          '/admin/automation/sandbox',
          { action: 'pause' },
          { headers },
        );
        expect(await tickSandbox(container, clock + 100_000)).toBe(false);
        expect(
          (
            await unwrapResponse(
              api.post(
                '/admin/automation/sandbox',
                { action: 'bonus', amount: 1, profileIds: ids },
                { headers },
              ),
            )
          ).status,
        ).toBe(409);
        await api.post(
          '/admin/automation/sandbox',
          { action: 'resume' },
          { headers },
        );
        await tickSandbox(container, clock + 100_000);
        view = (await api.get('/admin/automation/sandbox', { headers })).data;
        expect(view.completedCycles).toBe(2);
        await api.post(
          '/admin/automation/sandbox',
          { action: 'stop' },
          { headers },
        );
        expect(await tickSandbox(container, clock + 200_000)).toBe(false);
        expect(
          (await api.get('/admin/automation/sandbox', { headers })).data.status,
        ).toBe('stopped');
        const db = container.resolve(ContainerRegistrationKeys.PG_CONNECTION);
        expect(
          (
            await db.raw(
              'select count(*)::int as count from automation_sandbox',
            )
          ).rows[0].count,
        ).toBe(1);
        expect(
          await packs.listCreditTransactions({ customer_id: customer.id }),
        ).toEqual(ledgerBefore);
        expect(await packs.listAndCountPulls({})).toEqual(pullsBefore);
        expect((await customers.listAndCountCustomers({}))[1]).toBe(
          customerCount,
        );
      });
    });
  },
});
