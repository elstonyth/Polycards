import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'spend-report-password-1';

// GET /admin/customers/:id/spend-report — monthly pack_open spend for one
// customer, newest first, capped at 24 months.
//
// The months are bucketed in Asia/Kuala_Lumpur (every date boundary in this
// project is MYT), so the seeds below deliberately straddle a boundary that
// ONLY the MYT conversion resolves: 2026-02-28T17:00Z is 2026-03-01 01:00 MYT.
// Under UTC bucketing that row would land in '2026-02' and this spec fails —
// which is the point.

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('admin customer spend report', () => {
      let storeHeaders: Record<string, string>;
      let adminToken: string;

      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'spend-report-test',
          type: 'publishable',
          created_by: 'spend-report-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };
        adminToken = await mintSuperAdmin(
          container,
          api,
          'spend-report-admin@test.dev',
          PASSWORD,
        );
      });

      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      const registerCustomer = async (email: string): Promise<string> => {
        const reg = await api.post('/auth/customer/emailpass/register', {
          email,
          password: PASSWORD,
        });
        const created = await api.post(
          '/store/customers',
          { email },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${reg.data.token}`,
            },
          },
        );
        return created.data.customer.id;
      };

      const report = (customerId: string, headers: Record<string, string>) =>
        unwrapResponse(
          api.get(`/admin/customers/${customerId}/spend-report`, { headers }),
        );

      // created_at is ORM-managed on insert, so the ledger rows are backdated
      // with one raw UPDATE after they exist.
      const backdate = async (id: string, iso: string): Promise<void> => {
        const knex = getContainer().resolve(
          ContainerRegistrationKeys.PG_CONNECTION,
        ) as unknown as {
          raw: (sql: string, bindings: unknown[]) => Promise<unknown>;
        };
        await knex.raw(
          'UPDATE credit_transaction SET created_at = ? WHERE id = ?',
          [iso, id],
        );
      };

      it('rejects an unauthenticated read with 401', async () => {
        const customerId = await registerCustomer('spend-report-a@test.dev');
        expect((await report(customerId, {})).status).toBe(401);
      });

      it('buckets pack_open spend into MYT months, newest first', async () => {
        const customerId = await registerCustomer('spend-report-b@test.dev');
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);

        const rows = await packs.createCreditTransactions([
          // 2026-03-01 01:00 MYT — UTC would file this under '2026-02'.
          {
            customer_id: customerId,
            amount: -45,
            reason: 'pack_open' as const,
            pull_id: null,
            reference: null,
          },
          // Two opens in the same MYT month → one period summing to RM50.
          {
            customer_id: customerId,
            amount: -30,
            reason: 'pack_open' as const,
            pull_id: null,
            reference: null,
          },
          {
            customer_id: customerId,
            amount: -20,
            reason: 'pack_open' as const,
            pull_id: null,
            reference: null,
          },
          // A non-pack_open month must not produce a period at all.
          {
            customer_id: customerId,
            amount: 1000,
            reason: 'topup' as const,
            pull_id: null,
            reference: 'seed grant',
          },
        ]);
        const stamps = [
          '2026-02-28T17:00:00Z',
          '2026-04-15T00:00:00Z',
          '2026-04-20T00:00:00Z',
          '2026-01-15T00:00:00Z',
        ];
        for (const [i, row] of rows.entries()) {
          await backdate(row.id, stamps[i]);
        }

        const res = await report(customerId, adminHeaders());
        expect(res.status).toBe(200);
        expect(res.data.periods).toEqual([
          { period: '2026-04', spend: 50 },
          { period: '2026-03', spend: 45 },
        ]);
      });

      it('returns an empty period list for a customer with no spend', async () => {
        const customerId = await registerCustomer('spend-report-c@test.dev');
        const res = await report(customerId, adminHeaders());
        expect(res.status).toBe(200);
        expect(res.data.periods).toEqual([]);
      });
    });
  },
});
