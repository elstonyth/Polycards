import { medusaIntegrationTestRunner } from '@medusajs/test-utils';
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../src/modules/packs';
import type PacksModuleService from '../../src/modules/packs/service';
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

      const lineOf = (handle: string, qty: number) => ({
        card_handle: handle,
        card_name: handle,
        fmv_snapshot: 100,
        qty,
      });

      const edit = (id: string, body: Record<string, unknown>) =>
        unwrapResponse(
          api.post(
            `/admin/goods-receive-notes/${id}`,
            {
              date: '2026-10-28T00:00:00.000Z',
              supplier: 'Early Supplier',
              ...body,
            },
            headers(),
          ),
        );

      const movements = async (handle: string) =>
        (
          await unwrapResponse(api.get(`/admin/inventory/${handle}`, headers()))
        ).data.movements.rows
          .map((m: { kind: string; qty: number }) => `${m.kind}:${m.qty}`)
          .sort();

      it('edit: an open GRN keeps its number and moves stock by the difference only', async () => {
        await makeProduct('grn-edit-a', true);
        await makeProduct('grn-edit-b', true);
        const received = (await grn('grn-edit-a', 3)).data.goods_receive_note;

        const res = await edit(received.id, {
          date: '2026-10-30T16:00:00.000Z',
          supplier: 'Right Supplier',
          lines: [lineOf('grn-edit-a', 1), lineOf('grn-edit-b', 2)],
        });
        expect(res.status).toBe(200);
        expect(res.data.goods_receive_note.display_no).toBe(
          received.display_no,
        );

        const after = await detail(received.id);
        expect(after).toMatchObject({
          status: 'open',
          display_no: received.display_no,
          supplier: 'Right Supplier',
          total_qty: 3,
        });
        expect(new Date(after.date).toISOString()).toBe(
          '2026-10-30T16:00:00.000Z',
        );
        expect(
          after.lines.map(
            (l: { card_handle: string; qty: number }) =>
              `${l.card_handle} x ${l.qty}`,
          ),
        ).toEqual(expect.arrayContaining(['grn-edit-a x 1', 'grn-edit-b x 2']));
        expect(after.lines).toHaveLength(2);

        expect(await stockOf('grn-edit-a')).toMatchObject({
          on_hand: 1,
          counter: 1,
        });
        expect(await stockOf('grn-edit-b')).toMatchObject({
          on_hand: 2,
          counter: 2,
        });
        // Append-only history: the receipt, then the edit's difference.
        expect(await movements('grn-edit-a')).toEqual([
          'goods_receive:-2',
          'goods_receive:3',
        ]);
        expect(await movements('grn-edit-b')).toEqual(['goods_receive:2']);

        // Only the FMV changes: no stock moves, no new history row.
        const fmvOnly = await edit(received.id, {
          supplier: 'Right Supplier',
          lines: [
            { ...lineOf('grn-edit-a', 1), fmv_snapshot: 120 },
            lineOf('grn-edit-b', 2),
          ],
        });
        expect(fmvOnly.status).toBe(200);
        expect(await stockOf('grn-edit-a')).toMatchObject({
          on_hand: 1,
          counter: 1,
        });
        expect(await movements('grn-edit-a')).toHaveLength(2);

        // Who changed what is on record.
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        const audits = await packs.listAdminActionAudits(
          { entity_id: received.id, action: 'edit' },
          { order: { created_at: 'ASC' } },
        );
        expect(audits).toHaveLength(2);
        expect(audits[0]).toMatchObject({
          entity_type: 'goods_receive_note',
          before: {
            supplier: 'Early Supplier',
            lines: [{ card_handle: 'grn-edit-a', qty: 3, fmv_snapshot: 100 }],
          },
          after: {
            supplier: 'Right Supplier',
            lines: [
              {
                card_handle: 'grn-edit-a',
                card_name: 'grn-edit-a',
                qty: 1,
                fmv_snapshot: 100,
              },
              {
                card_handle: 'grn-edit-b',
                card_name: 'grn-edit-b',
                qty: 2,
                fmv_snapshot: 100,
              },
            ],
          },
        });

        // A transfer now mirrors the edited lines.
        const pi = await invoice({
          from_grn_id: received.id,
          lines: [
            { ...lineOf('grn-edit-a', 1), fmv_snapshot: 120, unit_cost: 50 },
            { ...lineOf('grn-edit-b', 2), unit_cost: 50 },
          ],
        });
        expect(pi.status).toBe(201);
        expect(await stockOf('grn-edit-a')).toMatchObject({ on_hand: 1 });
      });

      it('edit: refused once a GRN is transferred, reversed, or a reversal', async () => {
        await makeProduct('grn-edit-closed', true);
        const sent = (await grn('grn-edit-closed', 2)).data.goods_receive_note;
        expect(
          (
            await invoice({
              from_grn_id: sent.id,
              lines: [{ ...lineOf('grn-edit-closed', 2), unit_cost: 10 }],
            })
          ).status,
        ).toBe(201);
        const late = await edit(sent.id, {
          lines: [lineOf('grn-edit-closed', 1)],
        });
        expect(late.status).toBe(400);
        expect(late.data.message).toMatch(/already transferred/);

        const undone = (await grn('grn-edit-closed', 1)).data
          .goods_receive_note;
        const reversal = (await reverse(undone.id)).data.goods_receive_note;
        const reversed = await edit(undone.id, {
          lines: [lineOf('grn-edit-closed', 5)],
        });
        expect(reversed.status).toBe(400);
        expect(reversed.data.message).toMatch(/was reversed by GRN-/);
        const ofReversal = await edit(reversal.id, {
          lines: [lineOf('grn-edit-closed', 5)],
        });
        expect(ofReversal.status).toBe(400);
        expect(ofReversal.data.message).toMatch(/cannot be edited/);

        // None of the refused edits moved stock: 2 transferred, 1 - 1 reversed.
        expect(await stockOf('grn-edit-closed')).toMatchObject({
          on_hand: 2,
          counter: 2,
        });
      });

      it('edit: refuses a bad body and an unknown GRN', async () => {
        await makeProduct('grn-edit-bad', true);
        const received = (await grn('grn-edit-bad', 2)).data.goods_receive_note;
        const zero = await edit(received.id, {
          lines: [lineOf('grn-edit-bad', 0)],
        });
        expect(zero.status).toBe(400);
        const empty = await edit(received.id, { lines: [] });
        expect(empty.status).toBe(400);
        const unknown = await edit(received.id, {
          lines: [lineOf('no-such-product', 1)],
        });
        expect(unknown.status).toBe(400);
        expect(unknown.data.message).toMatch(/Unknown card_handle/);
        const missing = await edit('grn_nope', {
          lines: [lineOf('grn-edit-bad', 1)],
        });
        expect(missing.status).toBe(404);
        const badToken = await edit(received.id, {
          expected_updated_at: 'yesterday-ish',
          lines: [lineOf('grn-edit-bad', 1)],
        });
        expect(badToken.status).toBe(400);
        // The service's own guard, for callers that skip the route.
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        await expect(
          packs.updateGoodsReceiveNoteWithLines(received.id, {
            date: '2026-10-28T00:00:00.000Z',
            supplier: 'Early Supplier',
            agent_user_id: 'user_test',
            lines: [],
          }),
        ).rejects.toThrow(/quantity above 0/);
        expect(await stockOf('grn-edit-bad')).toMatchObject({ on_hand: 2 });
      });

      it('edit: a stale form is refused, and of two saves at once only one lands', async () => {
        await makeProduct('grn-edit-race', true);
        const received = (await grn('grn-edit-race', 3)).data
          .goods_receive_note;
        const loaded = (await detail(received.id)).updated_at;

        // Lines only, same date and supplier: the save still counts as a change.
        const first = await edit(received.id, {
          expected_updated_at: loaded,
          lines: [lineOf('grn-edit-race', 4)],
        });
        expect(first.status).toBe(200);
        const stale = await edit(received.id, {
          expected_updated_at: loaded,
          lines: [lineOf('grn-edit-race', 2)],
        });
        expect(stale.status).toBe(400);
        expect(stale.data.message).toMatch(/changed by someone else/);
        expect(await stockOf('grn-edit-race')).toMatchObject({
          on_hand: 4,
          counter: 4,
        });

        // Two saves from one loaded form at once: the GRN lock runs them one
        // after the other, and the second sees the first's updated_at.
        const now = (await detail(received.id)).updated_at;
        const both = await Promise.all(
          [5, 6].map((qty) =>
            edit(received.id, {
              expected_updated_at: now,
              lines: [lineOf('grn-edit-race', qty)],
            }),
          ),
        );
        expect(both.map((r) => r.status).sort()).toEqual([200, 400]);
        const total = (await detail(received.id)).total_qty;
        expect([5, 6]).toContain(total);
        expect(await stockOf('grn-edit-race')).toMatchObject({
          on_hand: total,
          counter: total,
        });
      });

      it('edit: a date fix keeps the lines, and a card whose product was deleted can stay', async () => {
        await makeProduct('grn-edit-gone', true);
        await makeProduct('grn-edit-other', true);
        const received = (await grn('grn-edit-gone', 2)).data
          .goods_receive_note;
        const idsBefore = (await detail(received.id)).lines.map(
          (l: { id: string }) => l.id,
        );
        const productModule = getContainer().resolve(Modules.PRODUCT);
        const [gone] = await productModule.listProducts({
          handle: 'grn-edit-gone',
        });
        await productModule.softDeleteProducts([gone.id]);

        const dateFix = await edit(received.id, {
          date: '2026-10-29T16:00:00.000Z',
          lines: [lineOf('grn-edit-gone', 2)],
        });
        expect(dateFix.status).toBe(200);
        expect(dateFix.data.goods_receive_note.delta).toBeUndefined();
        const after = await detail(received.id);
        expect(new Date(after.date).toISOString()).toBe(
          '2026-10-29T16:00:00.000Z',
        );
        expect(after.lines.map((l: { id: string }) => l.id)).toEqual(idsBefore);
        // No stock moved (the inventory page is gone with the product).
        const packs = getContainer().resolve<PacksModuleService>(PACKS_MODULE);
        expect(
          (
            await packs.listStockMovements({ card_handle: 'grn-edit-gone' })
          ).map((m) => Number(m.qty)),
        ).toEqual([2]);

        // ...but a deleted card cannot be added to another note.
        const other = (await grn('grn-edit-other', 1)).data.goods_receive_note;
        const added = await edit(other.id, {
          lines: [lineOf('grn-edit-other', 1), lineOf('grn-edit-gone', 1)],
        });
        expect(added.status).toBe(400);
        expect(added.data.message).toMatch(/Unknown card_handle/);
      });

      it('edit: taking a card off, then reversing, nets everything to zero', async () => {
        await makeProduct('grn-edit-keep', true);
        await makeProduct('grn-edit-drop', true);
        const received = (await grn('grn-edit-keep', 2)).data
          .goods_receive_note;
        expect(
          (
            await edit(received.id, {
              lines: [lineOf('grn-edit-keep', 2), lineOf('grn-edit-drop', 3)],
            })
          ).status,
        ).toBe(200);
        expect(await stockOf('grn-edit-drop')).toMatchObject({
          on_hand: 3,
          counter: 3,
        });

        // The card comes off the note entirely.
        expect(
          (await edit(received.id, { lines: [lineOf('grn-edit-keep', 1)] }))
            .status,
        ).toBe(200);
        expect(await stockOf('grn-edit-drop')).toMatchObject({
          on_hand: 0,
          counter: 0,
        });
        expect(await movements('grn-edit-drop')).toEqual([
          'goods_receive:-3',
          'goods_receive:3',
        ]);
        expect(await stockOf('grn-edit-keep')).toMatchObject({
          on_hand: 1,
          counter: 1,
        });

        // A reversal undoes the note as edited, not as first saved.
        const undo = await reverse(received.id);
        expect(undo.status).toBe(201);
        expect(
          undo.data.goods_receive_note.lines.map(
            (l: { card_handle: string; qty: number }) =>
              `${l.card_handle} x ${l.qty}`,
          ),
        ).toEqual(['grn-edit-keep x -1']);
        expect(await stockOf('grn-edit-keep')).toMatchObject({
          on_hand: 0,
          counter: 0,
        });
        expect(await stockOf('grn-edit-drop')).toMatchObject({
          on_hand: 0,
          counter: 0,
        });
        expect(await movements('grn-edit-keep')).toEqual([
          'goods_receive:-1',
          'goods_receive:-1',
          'goods_receive:2',
        ]);
      });

      // ---- Purchase invoice edit (user 2026-11-11) ----

      const piLine = (handle: string, qty: number, unit_cost: number) => ({
        card_handle: handle,
        card_name: handle,
        fmv_snapshot: 100,
        qty,
        unit_cost,
      });
      const editInvoice = (id: string, body: Record<string, unknown>) =>
        unwrapResponse(
          api.post(
            `/admin/purchase-invoices/${id}`,
            {
              date: '2026-10-29T00:00:00.000Z',
              supplier: 'Early Supplier',
              ...body,
            },
            headers(),
          ),
        );
      const invoiceDetail = async (id: string) =>
        (
          await unwrapResponse(
            api.get(`/admin/purchase-invoices/${id}`, headers()),
          )
        ).data.invoice;

      it('invoice edit: keeps its number, moves stock by the difference and re-averages the cost', async () => {
        await makeProduct('pi-edit-a', true);
        await makeProduct('pi-edit-b', true);
        const bought = (await invoice({ lines: [piLine('pi-edit-a', 3, 10)] }))
          .data.invoice;
        expect(await stockOf('pi-edit-a')).toMatchObject({
          on_hand: 3,
          counter: 3,
          cost: 10,
        });

        const loaded = await invoiceDetail(bought.id);
        expect(loaded.reversed_by).toBeNull();
        const res = await editInvoice(bought.id, {
          supplier: 'Typo Fixed',
          expected_updated_at: loaded.updated_at,
          lines: [piLine('pi-edit-a', 1, 12), piLine('pi-edit-b', 2, 5)],
        });
        expect(res.status).toBe(200);
        expect(res.data.invoice.display_no).toBe(bought.display_no);
        expect(res.data.invoice.supplier).toBe('Typo Fixed');
        expect(res.data.invoice).not.toHaveProperty('delta');
        expect(await stockOf('pi-edit-a')).toMatchObject({
          on_hand: 1,
          counter: 1,
          cost: 12,
        });
        expect(await stockOf('pi-edit-b')).toMatchObject({
          on_hand: 2,
          counter: 2,
          cost: 5,
        });
        // Append-only history: the purchase, then the edit's difference.
        expect(await movements('pi-edit-a')).toEqual([
          'purchase:-2',
          'purchase:3',
        ]);
        expect(await movements('pi-edit-b')).toEqual(['purchase:2']);
        const shown = await invoiceDetail(bought.id);
        expect(
          shown.lines.map(
            (l: { card_handle: string; qty: number; unit_cost: unknown }) =>
              `${l.card_handle} x ${l.qty} @ ${Number(l.unit_cost)}`,
          ),
        ).toEqual(
          expect.arrayContaining(['pi-edit-a x 1 @ 12', 'pi-edit-b x 2 @ 5']),
        );
        expect(shown.lines).toHaveLength(2);

        const [audit] = await getContainer()
          .resolve<PacksModuleService>(PACKS_MODULE)
          .listAdminActionAudits(
            {
              entity_type: 'purchase_invoice',
              entity_id: bought.id,
              action: 'edit',
            },
            { take: 1 },
          );
        expect(audit).toMatchObject({
          reason: 'purchase invoice edited',
          before: {
            supplier: 'Early Supplier',
            lines: [{ card_handle: 'pi-edit-a', qty: 3, unit_cost: 10 }],
          },
        });

        // The form loaded before that save is now stale: refused, unchanged.
        const stale = await editInvoice(bought.id, {
          expected_updated_at: loaded.updated_at,
          lines: [piLine('pi-edit-a', 9, 1)],
        });
        expect(stale.status).toBe(400);
        expect(stale.data.message).toMatch(/changed by someone else/);
        expect(await stockOf('pi-edit-a')).toMatchObject({ on_hand: 1 });

        // A reversal undoes the invoice as edited; then it can't be edited.
        const undo = await invoice({
          reverses_invoice_id: bought.id,
          lines: [piLine('pi-edit-a', -1, 12)],
        });
        expect(undo.status).toBe(201);
        const reversed = await invoiceDetail(bought.id);
        expect(reversed.reversed_by).toEqual({
          id: undo.data.invoice.id,
          display_no: undo.data.invoice.display_no,
        });
        const afterReverse = await editInvoice(bought.id, {
          lines: [piLine('pi-edit-a', 5, 12), piLine('pi-edit-b', 2, 5)],
        });
        expect(afterReverse.status).toBe(400);
        expect(afterReverse.data.message).toMatch(/was reversed by PI-\d{5}/);
        const ofReversal = await editInvoice(undo.data.invoice.id, {
          lines: [piLine('pi-edit-a', 1, 12)],
        });
        expect(ofReversal.status).toBe(400);
        expect(ofReversal.data.message).toMatch(/is itself a reversal/);
        expect(await stockOf('pi-edit-a')).toMatchObject({ on_hand: 0 });
      });

      it('invoice edit: one from a GRN changes its cost only and moves no stock', async () => {
        await makeProduct('pi-edit-grn', true);
        const received = (await grn('pi-edit-grn', 2)).data.goods_receive_note;
        const pi = (
          await invoice({
            from_grn_id: received.id,
            lines: [piLine('pi-edit-grn', 2, 40)],
          })
        ).data.invoice;

        const cost = await editInvoice(pi.id, {
          lines: [piLine('pi-edit-grn', 2, 45)],
        });
        expect(cost.status).toBe(200);
        expect(await stockOf('pi-edit-grn')).toMatchObject({
          on_hand: 2,
          counter: 2,
          cost: 45,
        });
        expect(await movements('pi-edit-grn')).toEqual(['goods_receive:2']);

        // The response's version is the stored one: a chained edit passes.
        const chained = await editInvoice(pi.id, {
          supplier: 'Renamed Supplier',
          expected_updated_at: cost.data.invoice.updated_at,
          lines: [piLine('pi-edit-grn', 2, 45)],
        });
        expect(chained.status).toBe(200);
        expect(chained.data.invoice.supplier).toBe('Renamed Supplier');

        for (const lines of [
          [piLine('pi-edit-grn', 3, 45)],
          [{ ...piLine('pi-edit-grn', 2, 45), fmv_snapshot: 999 }],
          [{ ...piLine('pi-edit-grn', 2, 45), card_name: 'Wrong Card' }],
        ]) {
          const refused = await editInvoice(pi.id, { lines });
          expect(refused.status).toBe(400);
          expect(refused.data.message).toMatch(
            /only its date, supplier and unit costs can change/,
          );
        }
        expect(await stockOf('pi-edit-grn')).toMatchObject({
          on_hand: 2,
          cost: 45,
        });
        // An edit can't turn an invoice into a reversal or a transfer.
        const sneaky = await editInvoice(pi.id, {
          from_grn_id: received.id,
          lines: [piLine('pi-edit-grn', 2, 45)],
        });
        expect(sneaky.status).toBe(400);
        expect((await detail(received.id)).status).toBe('transferred');
      });
    });
  },
});
