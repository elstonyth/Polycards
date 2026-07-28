import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'purchase-invoice-test-pw-1'; // gitleaks:allow
const ADMIN_EMAIL = 'purchase-invoice-admin@test.dev';

medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('admin purchase invoices — create', () => {
      let adminToken: string;
      let packs: PacksModuleService;

      beforeEach(async () => {
        packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        adminToken = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        // A fresh test DB has NO fx_rate row, so resolveFxRateStrict would
        // refuse every create. Pin a firm rate before any other call.
        await unwrapResponse(
          api.post(
            '/admin/pricing/fx',
            { manual_override: true, manual_rate: 4.5, reason: 'pin for test' },
            { headers: { authorization: `Bearer ${adminToken}` } },
          ),
        );
      });

      const adminHeaders = () => ({
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const create = (body: unknown) =>
        unwrapResponse(api.post('/admin/purchase-invoices', body, adminHeaders()));

      const LINE = {
        card_handle: 'charizard-psa-10',
        card_name: 'Charizard PSA 10',
        fmv_snapshot: 300,
        qty: 10,
        unit_cost: 150,
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const createOriginal = (lines: unknown[] = [LINE]): Promise<any> =>
        create({
          date: '2026-07-28T00:00:00.000Z',
          supplier: 'Acme Cards Sdn Bhd',
          reverses_invoice_id: null,
          lines,
        });

      const reverse = (targetId: string, lines: unknown[]) =>
        create({
          date: '2026-07-29T00:00:00.000Z',
          supplier: 'Acme Cards Sdn Bhd',
          reverses_invoice_id: targetId,
          lines,
        });

      it('creates an invoice with a PI-00001-style display_no and one stock_movement per line', async () => {
        const res = await createOriginal();
        expect(res.status).toBe(201);
        expect(res.data.invoice.display_no).toMatch(/^PI-\d{5}$/);
        expect(res.data.invoice.lines).toHaveLength(1);
        expect(Number(res.data.invoice.lines[0].line_total)).toBe(1500);

        const movements = await packs.listStockMovements(
          { card_handle: LINE.card_handle },
          { take: 10 },
        );
        expect(movements).toHaveLength(1);
        expect(movements[0]).toMatchObject({ kind: 'purchase', qty: 10 });

        const [audit] = await packs.listAdminActionAudits(
          {
            entity_type: 'purchase_invoice',
            entity_id: res.data.invoice.id,
          },
          { take: 1 },
        );
        expect(audit).toMatchObject({ action: 'create' });
      });

      it('two invoices get sequential display_no values', async () => {
        const a = await createOriginal();
        const b = await createOriginal();
        expect(a.data.invoice.display_no).not.toBe(b.data.invoice.display_no);
      });

      it('stores line_total as the UNROUNDED product so the DB half-sen check holds', async () => {
        // 3 * 0.07 is 0.21000000000000002 in JS but exactly 0.21 in Postgres
        // numeric — the CHECK tolerates that gap; a 2dp-rounded line_total
        // against a rounder qty would be the thing it must still catch.
        const res = await createOriginal([
          { ...LINE, card_handle: 'penny-common', qty: 3, unit_cost: 0.07 },
        ]);
        expect(res.status).toBe(201);
        expect(Number(res.data.invoice.lines[0].line_total)).toBeCloseTo(
          0.21,
          6,
        );
      });

      it('rejects a sub-sen unit_cost', async () => {
        const res = await createOriginal([{ ...LINE, unit_cost: 1.005 }]);
        expect(res.status).toBe(400);
      });

      it('rejects a reversal whose line does not match the target invoice on card_handle+unit_cost', async () => {
        const original = await createOriginal();
        const res = await reverse(original.data.invoice.id, [
          { ...LINE, qty: -10, unit_cost: 999 }, // wrong unit_cost
        ]);
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/does not match any line/i);
      });

      it('accepts a matching reversal and the invoice is retrievable', async () => {
        const original = await createOriginal();
        const reversal = await reverse(original.data.invoice.id, [
          { ...LINE, qty: -10 },
        ]);
        expect(reversal.status).toBe(201);
        expect(reversal.data.invoice.reverses_invoice_id).toBe(
          original.data.invoice.id,
        );
      });

      it('rejects a negative-qty line with no reverses_invoice_id', async () => {
        const res = await createOriginal([{ ...LINE, qty: -1 }]);
        expect(res.status).toBe(400);
      });

      it('rejects a reversal that reverses MORE than the target line carries', async () => {
        const original = await createOriginal();
        const res = await reverse(original.data.invoice.id, [
          { ...LINE, qty: -11 },
        ]);
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/exceeds/i);
      });

      it('rejects a SECOND full reversal of an already fully reversed invoice', async () => {
        const original = await createOriginal();
        const first = await reverse(original.data.invoice.id, [
          { ...LINE, qty: -10 },
        ]);
        expect(first.status).toBe(201);
        const second = await reverse(original.data.invoice.id, [
          { ...LINE, qty: -10 },
        ]);
        expect(second.status).toBe(400);
        expect(second.data.message).toMatch(/exceeds/i);
      });

      it('allows partial reversals up to the purchased qty, then refuses the overflow', async () => {
        const original = await createOriginal();
        const a = await reverse(original.data.invoice.id, [
          { ...LINE, qty: -4 },
        ]);
        expect(a.status).toBe(201);
        const b = await reverse(original.data.invoice.id, [
          { ...LINE, qty: -6 },
        ]);
        expect(b.status).toBe(201);
        const c = await reverse(original.data.invoice.id, [
          { ...LINE, qty: -1 },
        ]);
        expect(c.status).toBe(400);
        expect(c.data.message).toMatch(/exceeds/i);
      });

      it('rejects a reversal of a reversing invoice', async () => {
        const original = await createOriginal();
        const reversal = await reverse(original.data.invoice.id, [
          { ...LINE, qty: -10 },
        ]);
        const res = await reverse(reversal.data.invoice.id, [
          { ...LINE, qty: -10 },
        ]);
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/reversing invoice/i);
      });

      // The budget check is a read-then-write. Run in the route's own
      // (separate) transaction it was a TOCTOU: two concurrent POSTs of the
      // same -10 reversal both read a full budget and both returned 201 — ten
      // units bought, twenty reversed, and nothing downstream catches it
      // (weightedAverageCost just goes null, or skews once a second purchase
      // is in play). Fixed by taking pg_advisory_xact_lock on the target
      // inside the SAME transaction that writes the reversal.
      it('serializes two concurrent reversals of the same invoice', async () => {
        const original = await createOriginal();
        const [a, b] = await Promise.all([
          reverse(original.data.invoice.id, [{ ...LINE, qty: -10 }]),
          reverse(original.data.invoice.id, [{ ...LINE, qty: -10 }]),
        ]);
        expect([a.status, b.status].sort()).toEqual([201, 400]);

        const lines = await packs.listPurchaseInvoiceLines(
          { card_handle: LINE.card_handle },
          { take: 100 },
        );
        expect(lines.reduce((s, l) => s + Number(l.qty), 0)).toBe(0);
      });

      // The FX gate is the one money-safety guard here that the rest of this
      // suite can only prove NEGATIVELY (the beforeEach pin makes every other
      // test take the happy branch), so it needs its own row-clearing test —
      // otherwise deleting resolveFxRateStrict from the route leaves all of
      // them green. resolveFxRateStrict is deliberately uncached (only the
      // display resolver has the 30s process cache), so the clear bites at
      // once. fmv_snapshot is frozen forever at create; recording one priced
      // off the 4.7 display fallback during an FX-empty window is exactly the
      // silent mispricing this refuses.
      it('refuses to create when no firm FX rate exists', async () => {
        const rows = await packs.listFxRates({}, { take: 10 });
        await packs.deleteFxRates(rows.map((r) => r.id));
        const res = await createOriginal();
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/exchange rate unavailable/i);
      });

      // deletePurchaseInvoiceCascade is compensation-only, and the workflow's
      // inventory step swallows per-line failures, so nothing in the normal
      // flow can ever reach it — a hard delete of money records with zero
      // executions is a bad thing to first exercise during a production
      // rollback. Called directly here; this also covers all three generated
      // delete signatures (movements array, lines array, invoice string).
      it('deletePurchaseInvoiceCascade removes the invoice, its lines and its stock movements', async () => {
        const created = await createOriginal();
        const invoiceId = created.data.invoice.id;
        await packs.deletePurchaseInvoiceCascade(invoiceId);

        expect(
          await packs.listPurchaseInvoices({ id: invoiceId }, { take: 1 }),
        ).toHaveLength(0);
        expect(
          await packs.listPurchaseInvoiceLines(
            { invoice_id: invoiceId },
            { take: 10 },
          ),
        ).toHaveLength(0);
        expect(
          await packs.listStockMovements(
            { card_handle: LINE.card_handle },
            { take: 10 },
          ),
        ).toHaveLength(0);
      });

      it('sums repeated card_handle+unit_cost lines within ONE reversal body', async () => {
        const original = await createOriginal();
        const res = await reverse(original.data.invoice.id, [
          { ...LINE, qty: -6 },
          { ...LINE, qty: -6 },
        ]);
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/exceeds/i);
      });

      // Nested (not a sibling) describe: the list/detail cases need the outer
      // beforeEach's FX pin and the same adminHeaders/create/LINE closures.
      describe('list + detail', () => {
        const zephyr = () =>
          create({
            date: '2026-07-28T00:00:00.000Z',
            supplier: 'Zephyr Supply',
            reverses_invoice_id: null,
            lines: [LINE],
          });

        // Zephyr is created FIRST and Acme second on purpose: that makes
        // alphabetical order the REVERSE of creation order, which is the only
        // arrangement in which the ?sort= assertions below can fail. Sorting
        // on display_no (or date) would pass even with the allowlist broken,
        // because those already run in creation order.
        it('lists invoices newest-first with computed totals and the recording agent', async () => {
          const zeph = await zephyr();
          const acme = await createOriginal();

          const res = await unwrapResponse(
            api.get('/admin/purchase-invoices', adminHeaders()),
          );
          expect(res.status).toBe(200);
          expect(res.data.total).toBe(2);
          expect(res.data.invoices[0].id).toBe(acme.data.invoice.id); // newest first

          const row = res.data.invoices.find(
            (i: { supplier: string }) => i.supplier === 'Acme Cards Sdn Bhd',
          );
          expect(row.id).toBe(acme.data.invoice.id);
          expect(row.total_qty).toBe(10);
          expect(row.subtotal).toBe(1500);
          expect(row.total_fmv).toBe(3000); // fmv_snapshot(300) * qty(10)
          // agent_user_id is the minted admin's user id — the table shows a
          // human, so the join has to actually resolve, not just be present.
          expect(row.agent_email).toBe(ADMIN_EMAIL);

          // ?sort= is an allowlist: an unhonoured key degrades SILENTLY to
          // created_at. Both rows below are wrong under that degradation (and
          // under a dropped sort param, and under an ignored direction), which
          // is the whole point of the reversed creation order above.
          const asc = await unwrapResponse(
            api.get('/admin/purchase-invoices?sort=supplier:asc', adminHeaders()),
          );
          expect(asc.data.invoices[0].id).toBe(acme.data.invoice.id); // A < Z
          const desc = await unwrapResponse(
            api.get(
              '/admin/purchase-invoices?sort=supplier:desc',
              adminHeaders(),
            ),
          );
          expect(desc.data.invoices[0].id).toBe(zeph.data.invoice.id);
        });

        it('?q= filters by supplier or display_no substring', async () => {
          await createOriginal();
          const made = await zephyr();
          const bySupplier = await unwrapResponse(
            api.get('/admin/purchase-invoices?q=Zephyr', adminHeaders()),
          );
          expect(bySupplier.status).toBe(200);
          expect(bySupplier.data.total).toBe(1);
          expect(bySupplier.data.invoices[0].id).toBe(made.data.invoice.id);

          const byDisplayNo = await unwrapResponse(
            api.get(
              `/admin/purchase-invoices?q=${made.data.invoice.display_no}`,
              adminHeaders(),
            ),
          );
          expect(byDisplayNo.data.total).toBe(1);
          expect(byDisplayNo.data.invoices[0].id).toBe(made.data.invoice.id);
        });

        // `q` lands in the MIDDLE of a LIKE pattern. Unescaped, the operator
        // reads a table they believe they filtered and did not.
        it('?q= treats LIKE metacharacters as literal text', async () => {
          const withSupplier = (name: string) =>
            create({
              date: '2026-07-28T00:00:00.000Z',
              supplier: name,
              reverses_invoice_id: null,
              lines: [LINE],
            });
          const literal = await withSupplier('A_B Trading');
          await withSupplier('AXB Trading');

          // Escaped, `%` is a literal nothing here contains. Unescaped it
          // builds the pattern `%%%` and returns the WHOLE table.
          const pct = await unwrapResponse(
            api.get('/admin/purchase-invoices?q=%25', adminHeaders()),
          );
          expect(pct.status).toBe(200);
          expect(pct.data.total).toBe(0);

          // The discriminating case: `_` is LIKE's single-character wildcard,
          // so unescaped `A_B` also matches `AXB` (total 2). Escaped it is one
          // supplier; escaped-but-passed-through-as-a-literal-backslash is 0.
          const wildcard = await unwrapResponse(
            api.get('/admin/purchase-invoices?q=A_B', adminHeaders()),
          );
          expect(wildcard.data.total).toBe(1);
          expect(wildcard.data.invoices[0].id).toBe(literal.data.invoice.id);
        });

        it('GET /:id returns the full line list', async () => {
          const made = await createOriginal();
          const res = await unwrapResponse(
            api.get(
              `/admin/purchase-invoices/${made.data.invoice.id}`,
              adminHeaders(),
            ),
          );
          expect(res.status).toBe(200);
          expect(res.data.invoice.display_no).toBe(
            made.data.invoice.display_no,
          );
          expect(res.data.invoice.lines).toHaveLength(1);
          expect(res.data.invoice.lines[0].card_handle).toBe(LINE.card_handle);
          // Detail spreads ORM rows through (brief-specified), so money arrives
          // in the raw column shape and each bigNumber ALSO ships its
          // raw_<field> jsonb sidecar (raw_unit_cost, raw_line_total,
          // raw_fmv_snapshot) — Task 5 must read `unit_cost`, not `raw_*`.
          // Number() it, like Task 3's line_total assertions. The list route's
          // totals, by contrast, are already plain numbers via fromSen.
          expect(Number(res.data.invoice.lines[0].unit_cost)).toBe(150);
          expect(Number(res.data.invoice.lines[0].line_total)).toBe(1500);
        });

        it('GET /:id 404s on an unknown id', async () => {
          const res = await unwrapResponse(
            api.get('/admin/purchase-invoices/pinv_nonexistent', adminHeaders()),
          );
          expect(res.status).toBe(404);
          // Status alone is VACUOUS: an unrouted path 404s too, so this case
          // passed with [id]/route.ts deleted outright. Pin the handler's own
          // message - entity name plus the id it echoes back - which nothing
          // else in the stack emits.
          expect(res.data.message).toMatch(
            /purchase invoice 'pinv_nonexistent' not found/i,
          );
        });
      });
    });
  },
});
