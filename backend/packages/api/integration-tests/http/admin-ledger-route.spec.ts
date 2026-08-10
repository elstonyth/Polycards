import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { Modules } from '@medusajs/framework/utils';
import { mintSuperAdmin, postStoreCustomer, unwrapResponse } from './utils';

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
        const created = await postStoreCustomer(
          api,
          getContainer(),
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
        const byQ = await listLedger(`?q=${encodeURIComponent(emailPrefix)}`);
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

        // A SINGLE-DAY window covers that whole day. Before the bounds were
        // read as MYT calendar days this returned zero rows for every day
        // including today (`to` resolved to that day's midnight, so from=X&to=X
        // was a zero-width window) — the one wrong result an operator hits on
        // their first visit to the Transactions page.
        //
        // The day comes from the SEEDED ROW, not Date.now(): a run that crosses
        // MYT midnight between seeding and asserting would otherwise ask for
        // the wrong day and fail spuriously.
        const mytDay = new Date(
          new Date((matched as AdminLedgerRow).occurred_at).getTime() +
            8 * 60 * 60 * 1000,
        )
          .toISOString()
          .slice(0, 10);
        const sameDay = await listLedger(`?from=${mytDay}&to=${mytDay}`);
        expect(sameDay.some((e) => e.customer.id === id)).toBe(true);
      });

      it('?sort= orders by an allowlisted column; unknown keys degrade to occurred_at', async () => {
        // Two AD rows so there is something to reorder.
        await seedAdjustment('admin-ledger-sort-a@test.dev');
        await seedAdjustment('admin-ledger-sort-b@test.dev');

        const asc = await listLedger('?sort=display_id:asc');
        const ids = asc.map((e) => e.display_id);
        expect(ids.length).toBeGreaterThanOrEqual(2);
        // display_id is fixed-width `TT-YY-QN-NNNNNN` over ASCII, so a JS
        // code-unit sort and Postgres' collation agree. If that format ever
        // grows variable-width segments, compare with a collation-aware
        // comparator instead of widening the fixture and hoping.
        expect(ids).toEqual([...ids].sort());

        const desc = await listLedger('?sort=display_id:desc');
        expect(desc.map((e) => e.display_id)).toEqual([...ids].sort().reverse());

        // customer email lives in another module and the deltas render as one
        // Affect cell — neither is allowlisted, and the raw-SQL ORDER BY must
        // degrade rather than see the key. Silent degrade (the
        // purchase-invoices precedent), unlike this route's other params — and
        // to the WHOLE default, occurred_at DESC, not the `:asc` that came in
        // attached to a key we refused.
        const unknown = await listLedger('?sort=customer_email:asc');
        const stamps = unknown.map((e) => new Date(e.occurred_at).getTime());
        for (let i = 1; i < stamps.length; i++) {
          expect(stamps[i - 1]).toBeGreaterThanOrEqual(stamps[i]);
        }
      });

      it('400s an invalid type, date or q filter instead of silently widening it', async () => {
        // Silently ignoring these returned ALL types / ALL dates — a mistyped
        // filter showed the operator MORE money rows than they asked for,
        // while a bad ?limit= in the same handler already threw INVALID_DATA.
        for (const query of [
          '?type=SPP',
          '?from=not-a-date',
          '?to=2026-13-01',
          // `?q=a&q=b` arrives as an ARRAY. The old inline
          // `typeof rawQ === 'string'` check dropped it, widening the result
          // set to every row for the same reason a dropped ?type or ?from did.
          '?q=a&q=b',
        ]) {
          const res = await unwrapResponse(
            api.get(`/admin/ledger${query}`, { headers: adminHeaders() }),
          );
          expect([query, res.status]).toEqual([query, 400]);
        }
        // A CLEARED control submits '', which is "absent", not invalid. A
        // whitespace-only q is the same - no filter, not a 400 - so the
        // rejection above is the array shape, not "q looks empty".
        const cleared = await unwrapResponse(
          api.get('/admin/ledger?type=&from=&to=&q=%20%20', {
            headers: adminHeaders(),
          }),
        );
        expect(cleared.status).toBe(200);
      });

      it('escapes LIKE metacharacters in `q` — a literal `%` does not widen the search to every row', async () => {
        await seedAdjustment('admin-ledger-route-escape@test.dev');
        const unfiltered = await listLedger('');
        expect(unfiltered.length).toBeGreaterThan(0);

        // Unescaped, `?q=%` builds ILIKE '%%%' and matches EVERY row — the
        // operator would believe they filtered while seeing the whole table.
        // Escaped, it matches only rows whose display_id literally contains
        // '%', which none of the seeded display ids do.
        const percentOnly = await listLedger(`?q=${encodeURIComponent('%')}`);
        expect(percentOnly).toEqual([]);
      });

      it('401s an unauthenticated caller (the list carries every player email)', async () => {
        const res = await unwrapResponse(api.get('/admin/ledger'));
        expect(res.status).toBe(401);
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
