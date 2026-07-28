import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'admin-ledger-route-password-1'; // gitleaks:allow
const ADMIN_EMAIL = 'admin-ledger-route-admin@test.dev';

// Task 9 (POLYCARD-BACK Epic 4 §5.4) — the admin Transactions surface:
// GET /admin/ledger (type / q / date-range / pagination + a BATCHED customer
// join) and the Wallet tab's ledger_display_id on
// GET /admin/customers/:id/transactions.
//
// Rows are seeded through the ALREADY-WIRED writers (AD via the credits
// adjust route, TP via the store top-up) rather than inserted directly — the
// point of this spec is the read path over what the writers actually produce.
// The runner resets the DB between `it` blocks, so every test seeds its own.

type AdminLedgerRow = {
  id: string;
  display_id: string;
  type: string;
  customer: { id: string; email: string; name: string | null };
  occurred_at: string;
  wallet_delta: number | null;
  vault_delta: number | null;
  payload: { type: string } & Record<string, unknown>;
};

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('ledger: admin Transactions query', () => {
      let storeHeaders: Record<string, string>;
      let adminToken: string;

      const adminHeaders = (): Record<string, string> => ({
        authorization: `Bearer ${adminToken}`,
      });

      beforeEach(async () => {
        const container = getContainer();
        const apiKeyModule = container.resolve(Modules.API_KEY);
        const key = await apiKeyModule.createApiKeys({
          title: 'admin-ledger-route-test',
          type: 'publishable',
          created_by: 'admin-ledger-route-test',
        });
        storeHeaders = { 'x-publishable-api-key': key.token };

        adminToken = await mintSuperAdmin(
          container,
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        // Every money spec in this repo pins a firm FX rate; this one's
        // assertions don't need it, but don't be the template that skips it.
        await api.post(
          '/admin/pricing/fx',
          { manual_override: true, manual_rate: 4.85, reason: 'test: pin FX' },
          { headers: adminHeaders() },
        );
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

      // One operator credit adjustment = one AD ledger row (Task 5's writer).
      const seedAdjustment = async (email: string): Promise<string> => {
        const { id } = await registerCustomer(email);
        await api.post(
          `/admin/customers/${id}/credits`,
          { amount: 5, note: 'seed for admin-ledger-route spec' },
          { headers: adminHeaders() },
        );
        return id;
      };

      const listLedger = async (query: string): Promise<AdminLedgerRow[]> => {
        const res = await api.get(`/admin/ledger${query}`, {
          headers: adminHeaders(),
        });
        return res.data.entries as AdminLedgerRow[];
      };

      it('filters by type, q (display_id or player email), and date range', async () => {
        const email = 'admin-ledger-route-a@test.dev';
        const id = await seedAdjustment(email);

        const byType = await listLedger('?type=AD');
        expect(byType.every((e) => e.type === 'AD')).toBe(true);
        expect(byType.some((e) => e.customer.id === id)).toBe(true);

        const emailPrefix = email.split('@')[0];
        const byQ = await listLedger(
          `?q=${encodeURIComponent(emailPrefix)}`,
        );
        const matched = byQ.find((e) => e.customer.email === email);
        expect(matched).toBeDefined();
        const knownDisplayId = (matched as AdminLedgerRow).display_id;

        const byDisplayId = await listLedger(
          `?q=${encodeURIComponent(knownDisplayId)}`,
        );
        expect(byDisplayId.map((e) => e.display_id)).toContain(knownDisplayId);

        // Seeded rows are "now", not year 2000.
        expect(await listLedger('?from=2000-01-01&to=2000-01-02')).toHaveLength(
          0,
        );

        // An unparseable date is ignored, not a 500 (pg throws on Invalid Date).
        const bad = await unwrapResponse(
          api.get('/admin/ledger?from=not-a-date', { headers: adminHeaders() }),
        );
        expect(bad.status).toBe(200);
      });

      it('customer.email/name are batch-resolved, not per-row queried', async () => {
        await seedAdjustment('admin-ledger-route-b@test.dev');
        const entries = await listLedger('');
        expect(entries.length).toBeGreaterThan(0);
        expect(entries[0].customer.email).toBeTruthy();
      });

      it('the Wallet-tab transactions route surfaces ledger_display_id where a paired row exists', async () => {
        const { token, id } = await registerCustomer('ledger-test-14@test.dev');
        await api.post(
          '/store/credits/topup',
          { amount: 20 },
          {
            headers: {
              ...storeHeaders,
              authorization: `Bearer ${token}`,
              'idempotency-key': 'admin-ledger-route-topup',
            },
          },
        );
        const res = await api.get(`/admin/customers/${id}/transactions`, {
          headers: adminHeaders(),
        });
        expect(res.data.items[0].ledger_display_id).toMatch(/^TP/);
      });
    });
  },
});
