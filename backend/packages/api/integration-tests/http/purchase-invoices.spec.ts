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

      it('sums repeated card_handle+unit_cost lines within ONE reversal body', async () => {
        const original = await createOriginal();
        const res = await reverse(original.data.invoice.id, [
          { ...LINE, qty: -6 },
          { ...LINE, qty: -6 },
        ]);
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/exceeds/i);
      });
    });
  },
});
