import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'ledger-adjust-test-password-1'; // gitleaks:allow
const ADMIN_EMAIL = 'ledger-adjust-admin@test.dev';

// Task 5 (POLYCARD-BACK Epic 4 §5.3) — the AD ledger writer wired into
// adminAdjustCredit: an operator credit grant/deduction appends exactly ONE
// AD ledger row (wallet_delta only, signed) in the SAME transaction as the
// credit_transaction write AND the admin_action_audit row. Balance-floor,
// validation, and 401/404 behavior is credit-adjust.spec.ts's job; the
// audit-row side of this same event is admin-adjust-audit.spec.ts's job —
// this file only tests the new ledger row.

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('ledger: AD writer — operator adjustment', () => {
      let storeHeaders: Record<string, string>;
      let adminToken: string;

      // The runner resets the database between `it` blocks, so the publishable
      // key, the admin user, and any customers are recreated per test.
      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'ledger-adjust-test',
          type: 'publishable',
          created_by: 'ledger-adjust-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

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

      const registerCustomer = async (
        email: string,
      ): Promise<{ token: string; id: string }> => {
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
        const login = await api.post('/auth/customer/emailpass', {
          email,
          password: PASSWORD,
        });
        return { token: login.data.token, id: created.data.customer.id };
      };

      const ledgerEntryRowsFor = async (customerId: string, type?: string) => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const filter: Record<string, unknown> = { customer_id: customerId };
        if (type) filter.type = type;
        return packs.listLedgerEntries(filter, {
          order: { occurred_at: 'DESC' },
        });
      };

      it('an admin adjustment writes ONE AD ledger row alongside the audit row', async () => {
        const { id } = await registerCustomer('ledger-test-3@test.dev');
        await api.post(
          `/admin/customers/${id}/credits`,
          { amount: 15, note: 'goodwill credit' },
          { headers: adminHeaders() },
        );
        const rows = await ledgerEntryRowsFor(id, 'AD');
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].wallet_delta)).toBe(15);
        expect(rows[0].vault_delta).toBeNull();
      });

      it('a deduction (negative amount) records the signed delta', async () => {
        const { id } = await registerCustomer('ledger-test-4@test.dev');
        await api.post(
          `/admin/customers/${id}/credits`,
          { amount: 30, note: 'seed' },
          { headers: adminHeaders() },
        );
        await api.post(
          `/admin/customers/${id}/credits`,
          { amount: -10, note: 'correction' },
          { headers: adminHeaders() },
        );
        const rows = await ledgerEntryRowsFor(id, 'AD');
        expect(rows).toHaveLength(2);
        expect(
          rows.map((r) => Number(r.wallet_delta)).sort((a, b) => a - b),
        ).toEqual([-10, 30]);
      });
    });
  },
});
