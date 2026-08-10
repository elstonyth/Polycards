import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

// Ordering of the GlobePay deposit list against a REAL database.
//
// WHY this file exists rather than another mocked unit test: `amount_requested`
// and `amount_settled` are `model.bigNumber()` fields, which Medusa stores as a
// numeric column PLUS a `raw_<field>` jsonb sidecar. Every other `order:` in
// this repo targets a timestamp, an enum, or an id — these are the first money
// sorts. A unit test that captures the `order` object off a mock passes exactly
// the same whether or not MikroORM can resolve that property to an orderable
// column, which is the shape of this repo's documented bigNumber trap.
//
// The amounts are 9 and 100 on purpose: they sort the SAME way numerically and
// lexicographically only if the comparison is numeric. Text ordering would put
// '100' before '9', so a sort that silently fell through to the jsonb sidecar
// (or to a text cast) fails here instead of shipping.
const PASSWORD = 'globepay-list-order-password-1'; // gitleaks:allow
const ADMIN_EMAIL = 'globepay-list-order-admin@test.dev';
const CUSTOMER_ID = 'cus_globepay_list_order';
const SMALL = 'PC-list-order-small';
const LARGE = 'PC-list-order-large';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('GET /admin/globepay/deposits ordering', () => {
      let adminToken: string;

      const packs = (): PacksModuleService =>
        getContainer().resolve<PacksModuleService>(PACKS_MODULE);

      beforeEach(async () => {
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );

        // Seeded oldest-first so created_at order and amount order DISAGREE —
        // otherwise a sort that silently ignored `?sort=` would still look
        // correct.
        await packs().createGlobePayDeposits([
          {
            merchant_transaction_id: LARGE,
            customer_id: CUSTOMER_ID,
            amount_requested: 100,
            amount_settled: 100,
            payment_method_code: 'BQR',
            status: 'settled',
          },
        ]);
        await packs().createGlobePayDeposits([
          {
            merchant_transaction_id: SMALL,
            customer_id: CUSTOMER_ID,
            amount_requested: 9,
            payment_method_code: 'BQR',
            status: 'pending',
          },
        ]);
      });

      const list = async (qs: string): Promise<string[]> => {
        const res = await unwrapResponse(
          api.get(`/admin/globepay/deposits${qs}`, {
            headers: { authorization: `Bearer ${adminToken}` },
          }),
        );
        expect(res.status).toBe(200);
        return (
          res.data.deposits as { merchant_transaction_id: string }[]
        ).map((d) => d.merchant_transaction_id);
      };

      it('orders the bigNumber money column numerically, not as text', async () => {
        expect(await list('?status=all&sort=amount_requested:asc')).toEqual([
          SMALL,
          LARGE,
        ]);
        expect(await list('?status=all&sort=amount_requested:desc')).toEqual([
          LARGE,
          SMALL,
        ]);
      });

      // The Credited column: nullable, because a pending deposit has no settled
      // amount yet. Postgres orders NULLS FIRST on DESC, so the first click on
      // that header leads with the uncredited rows. Pinned rather than fixed —
      // "not yet credited" at the top of a descending credited-amount list is
      // defensible, and a future NULLS LAST should be a deliberate change that
      // fails this assertion rather than a silent reshuffle.
      it('places uncredited rows first on a descending Credited sort', async () => {
        expect(await list('?status=all&sort=amount_settled:desc')).toEqual([
          SMALL,
          LARGE,
        ]);
        expect(await list('?status=all&sort=amount_settled:asc')).toEqual([
          LARGE,
          SMALL,
        ]);
      });

      it('keeps the status-dependent default order when ?sort= is absent', async () => {
        // Pending view: oldest first (the stranded-payment work queue). Only
        // SMALL is pending, so this asserts the view still filters and returns.
        expect(await list('?status=pending')).toEqual([SMALL]);
        // History view: newest first — LARGE was seeded before SMALL, so
        // newest-first must put SMALL ahead of it.
        expect(await list('?status=all')).toEqual([SMALL, LARGE]);
      });

      it('degrades an unknown sort key instead of 400ing or reaching the query', async () => {
        // customer_email is joined in JS after the page is fetched — it is not
        // a column, and the allowlist must swallow it silently (the
        // purchase-invoices precedent) rather than hand it to the query builder.
        // Degrading restores the VIEW's whole default, direction included, so
        // the history view stays newest-first despite the `:asc`.
        expect(await list('?status=all&sort=customer_email:asc')).toEqual([
          SMALL,
          LARGE,
        ]);
        // ...and the pending work queue stays oldest-first. SMALL is the only
        // pending row, so this asserts the view survives rather than 400s.
        expect(await list('?sort=customer_email:desc')).toEqual([SMALL]);
      });
    });
  },
});
