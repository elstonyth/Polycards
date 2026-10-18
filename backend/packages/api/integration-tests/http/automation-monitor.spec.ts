import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240_000);

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('read-only Automation', () => {
      it('persists 80 existing accounts, reads their balances, and never transacts', async () => {
        const container = getContainer();
        const token = await mintSuperAdmin(
          container,
          api,
          'monitor-admin@example.test',
          'monitor-test-password',
        );
        const headers = { authorization: `Bearer ${token}` };
        const packs = container.resolve<PacksModuleService>(PACKS_MODULE);
        const customers = container.resolve(Modules.CUSTOMER);
        const emails = Array.from(
          { length: 80 },
          (_, index) => `monitor-${index}@example.test`,
        );
        const created = await customers.createCustomers(
          emails.map((email) => ({ email, has_account: true })),
        );
        const ids = created.map((customer) => customer.id);
        await packs.createCreditTransactions(
          ids.map((id, index) => ({
            customer_id: id,
            amount: (10_012 + index) / 100,
            reason: 'topup' as const,
          })),
        );
        const before = await packs.listCreditTransactions(
          { customer_id: ids },
          { take: 100 },
        );
        const pullsBefore = await packs.listAndCountPulls({ customer_id: ids });

        expect(
          (await unwrapResponse(api.get('/admin/automation'))).status,
        ).toBe(401);
        expect(
          (await api.get('/admin/automation', { headers })).data.accounts,
        ).toEqual([]);
        const imported = await api.post(
          '/admin/automation/accounts',
          { emails },
          { headers },
        );
        expect(imported.data).toEqual({
          mode: 'read-only',
          automationEnabled: false,
          count: 80,
        });
        // A second save replaces the selection instead of creating duplicate rows.
        await api.post('/admin/automation/accounts', { emails }, { headers });
        expect((await packs.listAutomationMonitors({})).length).toBe(1);

        const view = await api.get('/admin/automation', { headers });
        expect(view.headers['cache-control']).toContain('no-store');
        expect(view.data.automationEnabled).toBe(false);
        expect(view.data.accounts).toHaveLength(80);
        expect(view.data.accounts.map((row: { id: string }) => row.id)).toEqual(
          ids,
        );
        for (const [index, account] of view.data.accounts.entries()) {
          expect(account.balance).toBe((10_012 + index) / 100);
          expect(account.email).toBe(emails[index]);
          expect(account.status).toBe('active');
        }

        const rejected = await unwrapResponse(
          api.post(
            '/admin/automation/accounts',
            {
              emails: [emails[0], 'unknown@example.test'],
            },
            { headers },
          ),
        );
        expect(rejected.status).toBe(400);
        expect(
          (await api.get('/admin/automation', { headers })).data.accounts,
        ).toHaveLength(80);

        for (const action of [
          'run',
          'pause',
          'resume',
          'stop',
          'bonus-credits',
        ]) {
          expect(
            (
              await unwrapResponse(
                api.post(`/admin/automation/${action}`, {}, { headers }),
              )
            ).status,
          ).toBe(404);
        }
        for (const period of ['weekly', 'alltime']) {
          const board = await api.get(
            `/admin/automation/leaderboard?period=${period}`,
            { headers },
          );
          expect(board.data).toEqual({ period, entries: [] });
        }
        expect(
          (
            await unwrapResponse(
              api.get('/admin/automation/leaderboard?period=invalid', {
                headers,
              }),
            )
          ).status,
        ).toBe(400);
        expect(
          await packs.listCreditTransactions(
            { customer_id: ids },
            { take: 100 },
          ),
        ).toEqual(before);
        expect(await packs.listAndCountPulls({ customer_id: ids })).toEqual(
          pullsBefore,
        );

        await customers.softDeleteCustomers([ids[79]]);
        const afterDelete = await api.get('/admin/automation', { headers });
        expect(afterDelete.data.accounts[79]).toEqual({
          id: ids[79],
          name: null,
          email: null,
          balance: null,
          status: 'unavailable',
        });
      });
    });
  },
});
