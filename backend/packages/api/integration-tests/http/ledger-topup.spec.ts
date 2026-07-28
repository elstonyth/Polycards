import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'ledger-topup-test-password-1'; // gitleaks:allow
const ADMIN_EMAIL = 'ledger-topup-admin@test.dev';

// Task 4 (POLYCARD-BACK Epic 4 §5.3) — the TP ledger writer wired into the
// top-up gateway path: an approved top-up appends exactly ONE TP ledger row
// (wallet_delta only, same amount as the credit_transaction) in the SAME
// transaction as the credit write; a replayed Idempotency-Key must not
// double-write the ledger, mirroring credit_transaction's own replay
// guarantee (see credit-topup.spec.ts).

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('ledger: TP writer — top-up', () => {
      let storeHeaders: Record<string, string>;
      let adminToken: string;

      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      // The runner resets the database between `it` blocks, so the publishable
      // key, the admin user, and any customers are recreated per test.
      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'ledger-topup-test',
          type: 'publishable',
          created_by: 'ledger-topup-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        adminToken = await mintSuperAdmin(
          container,
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        // This spec's own assertions are id-shape/amount only and don't need
        // FX, but every money spec in this repo pins a firm FX rate — do it
        // anyway so nobody copies this file as a template that skips it.
        await api.post(
          '/admin/pricing/fx',
          { manual_override: true, manual_rate: 4.85, reason: 'test: pin FX' },
          { headers: adminHeaders() },
        );
      });

      const authed = (token: string): Record<string, string> => ({
        ...storeHeaders,
        authorization: `Bearer ${token}`,
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

      // Deliberately a DIFFERENT name from credit-topup.spec.ts's own
      // `ledgerRows` (which reads credit_transaction) so nobody confuses the
      // two "ledger" words in this codebase.
      const ledgerEntryRowsFor = async (
        customerId: string,
        type?: string,
      ): Promise<Awaited<ReturnType<PacksModuleService['listLedgerEntries']>>> => {
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const filter: Record<string, unknown> = { customer_id: customerId };
        if (type) filter.type = type;
        return packs.listLedgerEntries(filter, {
          order: { occurred_at: 'DESC' },
        });
      };

      it('a top-up writes ONE TP ledger row, same amount, wallet_delta only', async () => {
        const { token, id } = await registerCustomer('ledger-test-1@test.dev');
        const res = await api.post(
          '/store/credits/topup',
          { amount: 50 },
          { headers: { ...authed(token), 'idempotency-key': 'ik-1' } },
        );
        expect(res.status).toBe(200);

        const rows = await ledgerEntryRowsFor(id, 'TP');
        expect(rows).toHaveLength(1);
        expect(Number(rows[0].wallet_delta)).toBe(50);
        expect(rows[0].vault_delta).toBeNull();
        expect(rows[0].display_id).toMatch(/^TP\d{2}Q[1-4][A-Za-z]+\d{4}$/);
      });

      it('a replayed top-up (same idempotency key) does not double-write the ledger', async () => {
        const { token, id } = await registerCustomer('ledger-test-2@test.dev');
        const headers = { ...authed(token), 'idempotency-key': 'ik-2' };
        await api.post('/store/credits/topup', { amount: 20 }, { headers });
        await api.post('/store/credits/topup', { amount: 20 }, { headers }); // replay
        const rows = await ledgerEntryRowsFor(id, 'TP');
        expect(rows).toHaveLength(1);
      });
    });
  },
});
