import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from '@medusajs/framework/utils';
import { mintSuperAdmin, unwrapResponse } from './utils';

jest.setTimeout(240 * 1000);

const PASSWORD = 'grn-test-pw-1'; // gitleaks:allow
const ADMIN_EMAIL = 'grn-admin@test.dev';

// Goods receive notes + "transfer from goods receive note" (spec 2026-10-28),
// end to end through the real routes. Reads both stock numbers off the
// inventory detail row: on_hand (physical, received − shipped) and counter
// (the Medusa counter) — the two must each move exactly once per card.
medusaIntegrationTestRunner({
  inApp: true,
  testSuite: ({ api, getContainer }) => {
    describe('goods receive notes', () => {
      let token: string;
      const headers = () => ({
        headers: { authorization: `Bearer ${token}` },
      });

      beforeEach(async () => {
        token = await mintSuperAdmin(
          getContainer(),
          api,
          ADMIN_EMAIL,
          PASSWORD,
        );
        // Invoice creates refuse without a firm FX rate (purchase-invoices).
        await unwrapResponse(
          api.post(
            '/admin/pricing/fx',
            { manual_override: true, manual_rate: 4.5, reason: 'pin for test' },
            headers(),
          ),
        );
      });

      const makeProduct = async (handle: string, tracked: boolean) => {
        const productModule = getContainer().resolve(Modules.PRODUCT);
        const [product] = await productModule.createProducts([
          {
            title: handle,
            handle,
            status: ProductStatus.PUBLISHED,
            ...(tracked
              ? {
                  options: [{ title: 'Format', values: ['Slab'] }],
                  variants: [
                    {
                      title: 'Slab',
                      sku: handle,
                      manage_inventory: true,
                      options: { Format: 'Slab' },
                    },
                  ],
                }
              : {}),
          },
        ]);
        if (!tracked) return;
        // A tracked product needs a location, an item, a level and the
        // variant -> item link (inventory-detail.spec's recipe).
        const location = await getContainer()
          .resolve(Modules.STOCK_LOCATION)
          .createStockLocations({ name: `${handle} shelf` });
        const inventory = getContainer().resolve(Modules.INVENTORY);
        const item = await inventory.createInventoryItems({ sku: handle });
        await inventory.createInventoryLevels([
          {
            inventory_item_id: item.id,
            location_id: location.id,
            stocked_quantity: 0,
          },
        ]);
        await getContainer()
          .resolve(ContainerRegistrationKeys.LINK)
          .create({
            [Modules.PRODUCT]: { variant_id: product.variants[0].id },
            [Modules.INVENTORY]: { inventory_item_id: item.id },
          });
      };

      const stockOf = async (handle: string) => {
        const res = await unwrapResponse(
          api.get(`/admin/inventory/${handle}`, headers()),
        );
        const { on_hand, counter, cost } = res.data.item;
        return { on_hand, counter, cost };
      };

      const grn = (handle: string, qty: number) =>
        unwrapResponse(
          api.post(
            '/admin/goods-receive-notes',
            {
              date: '2026-10-28T00:00:00.000Z',
              supplier: 'Early Supplier',
              lines: [
                {
                  card_handle: handle,
                  card_name: handle,
                  fmv_snapshot: 100,
                  qty,
                },
              ],
            },
            headers(),
          ),
        );

      const invoice = (body: Record<string, unknown>) =>
        unwrapResponse(
          api.post(
            '/admin/purchase-invoices',
            {
              date: '2026-10-29T00:00:00.000Z',
              supplier: 'Early Supplier',
              reverses_invoice_id: null,
              ...body,
            },
            headers(),
          ),
        );

      const reverse = (id: string) =>
        unwrapResponse(
          api.post(`/admin/goods-receive-notes/${id}/reverse`, {}, headers()),
        );

      const detail = async (id: string) =>
        (
          await unwrapResponse(
            api.get(`/admin/goods-receive-notes/${id}`, headers()),
          )
        ).data.goods_receive_note;

      const openIds = async () =>
        (
          await unwrapResponse(
            api.get('/admin/goods-receive-notes?status=open', headers()),
          )
        ).data.goods_receive_notes.map((g: { id: string }) => g.id);

      it('a GRN raises on hand and the counter; its reversal lowers both, once', async () => {
        await makeProduct('grn-card', true);
        const res = await grn('grn-card', 3);
        expect(res.status).toBe(201);
        const created = res.data.goods_receive_note;
        expect(created.display_no).toMatch(/^GRN-\d{5}$/);
        expect(await stockOf('grn-card')).toMatchObject({
          on_hand: 3,
          counter: 3,
          cost: null, // a GRN carries no cost
        });
        expect((await detail(created.id)).status).toBe('open');
        expect(await openIds()).toContain(created.id);

        const undo = await reverse(created.id);
        expect(undo.status).toBe(201);
        expect(undo.data.goods_receive_note.lines[0].qty).toBe(-3);
        expect(await stockOf('grn-card')).toMatchObject({
          on_hand: 0,
          counter: 0,
        });
        expect((await detail(created.id)).status).toBe('reversed');
        expect((await detail(undo.data.goods_receive_note.id)).status).toBe(
          'reversal',
        );
        expect(await openIds()).not.toContain(created.id);

        const again = await reverse(created.id);
        expect(again.status).toBe(400);
        expect(again.data.message).toMatch(/was reversed by GRN-/);
        const ofReversal = await reverse(undo.data.goods_receive_note.id);
        expect(ofReversal.status).toBe(400);
        expect(ofReversal.data.message).toMatch(/is itself a reversal/);
      });

      it('saves a GRN for a product Medusa does not track', async () => {
        await makeProduct('grn-untracked', false);
        expect((await grn('grn-untracked', 2)).status).toBe(201);
        expect(await stockOf('grn-untracked')).toMatchObject({
          on_hand: 2,
          counter: null,
        });
      });

      it('rejects a GRN line for an unknown product', async () => {
        const res = await grn('no-such-product', 1);
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/Unknown card_handle/);
      });

      it('transfer: the invoice adds cost only, happens once, and its reversal leaves stock alone', async () => {
        await makeProduct('grn-transfer', true);
        const received = (await grn('grn-transfer', 2)).data.goods_receive_note;
        const line = {
          card_handle: 'grn-transfer',
          card_name: 'grn-transfer',
          fmv_snapshot: 100,
          qty: 2,
          unit_cost: 60,
        };

        const pi = await invoice({ from_grn_id: received.id, lines: [line] });
        expect(pi.status).toBe(201);
        expect(await stockOf('grn-transfer')).toEqual({
          on_hand: 2, // not 4: the GRN already counted these cards
          counter: 2,
          cost: 60,
        });
        const after = await detail(received.id);
        expect(after.status).toBe('transferred');
        expect(after.invoice.display_no).toBe(pi.data.invoice.display_no);
        expect(await openIds()).not.toContain(received.id);

        const list = await unwrapResponse(
          api.get('/admin/purchase-invoices', headers()),
        );
        const row = list.data.invoices.find(
          (i: { id: string }) => i.id === pi.data.invoice.id,
        );
        expect(row.from_grn_display_no).toBe(received.display_no);

        const twice = await invoice({
          from_grn_id: received.id,
          lines: [line],
        });
        expect(twice.status).toBe(400);
        expect(twice.data.message).toMatch(/already transferred/);
        const late = await reverse(received.id);
        expect(late.status).toBe(400);
        expect(late.data.message).toMatch(/already transferred/);

        // A transferred invoice is reversed in full or not at all.
        const partial = await invoice({
          reverses_invoice_id: pi.data.invoice.id,
          lines: [{ ...line, qty: -1 }],
        });
        expect(partial.status).toBe(400);
        expect(partial.data.message).toMatch(/can only be reversed in full/);

        // Fixing the invoice's cost must not take the cards back off the shelf.
        const undo = await invoice({
          reverses_invoice_id: pi.data.invoice.id,
          lines: [{ ...line, qty: -2 }],
        });
        expect(undo.status).toBe(201);
        expect(await stockOf('grn-transfer')).toMatchObject({
          on_hand: 2,
          counter: 2,
        });

        // ...and the full reversal re-opens the note, so the corrected cost is
        // a fresh transfer — not a plain invoice that would count the 2 cards
        // a second time (review finding 2026-10-28).
        expect((await detail(received.id)).status).toBe('open');
        expect(await openIds()).toContain(received.id);
        const fixed = await invoice({
          from_grn_id: received.id,
          lines: [{ ...line, unit_cost: 50 }],
        });
        expect(fixed.status).toBe(201);
        expect(await stockOf('grn-transfer')).toEqual({
          on_hand: 2,
          counter: 2,
          cost: 50,
        });
        const now = await detail(received.id);
        expect(now.status).toBe('transferred');
        expect(now.invoice.display_no).toBe(fixed.data.invoice.display_no);

        // Cost-only invoices write no stock movement: the history shows the
        // 2 cards once, from the GRN.
        const history = await unwrapResponse(
          api.get('/admin/inventory/grn-transfer', headers()),
        );
        expect(
          history.data.movements.rows.map(
            (m: { kind: string; qty: number }) => `${m.kind}:${m.qty}`,
          ),
        ).toEqual(['goods_receive:2']);
      });

      it('refuses a transfer whose lines differ from the GRN', async () => {
        await makeProduct('grn-mismatch', true);
        const received = (await grn('grn-mismatch', 2)).data.goods_receive_note;
        const res = await invoice({
          from_grn_id: received.id,
          lines: [
            {
              card_handle: 'grn-mismatch',
              card_name: 'grn-mismatch',
              fmv_snapshot: 100,
              qty: 1,
              unit_cost: 60,
            },
          ],
        });
        expect(res.status).toBe(400);
        expect(res.data.message).toMatch(/every line of GRN-\d{5} unchanged/);
        expect((await detail(received.id)).status).toBe('open');

        // Same cards and qty but another FMV is refused too: only the cost is
        // the operator's on a transfer.
        const fmv = await invoice({
          from_grn_id: received.id,
          lines: [
            {
              card_handle: 'grn-mismatch',
              card_name: 'grn-mismatch',
              fmv_snapshot: 999,
              qty: 2,
              unit_cost: 60,
            },
          ],
        });
        expect(fmv.status).toBe(400);
        expect(fmv.data.message).toMatch(/@ FMV 999\.00/);
      });
    });
  },
});
