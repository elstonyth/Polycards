import { model } from '@medusajs/framework/utils';

// StockMovement — append-only AUDIT LOG (§3.1), NOT a source of truth. Every
// bucket the Inventory page shows is computed from its real owning table
// (on-hand: card-stock.ts's Medusa inventory counter; in-vault: Pull;
// requested/shipped: DeliveryOrder+DeliveryOrderItem) — never from this
// table. This epic writes ONLY the 'purchase' kind (one row per invoice
// line). The other kinds are real states a unit passes through, but writing
// them needs the open-pack workflow ('pull'), buyback ('vault_out'), and the
// delivery-order transition ('requested'/'shipped'/'completed') — outside
// this epic's scope (see the plan's Open Items). 'adjustment' is reserved for
// a future manual-correction tool. Defining the full enum now is additive and
// free: no migration needed when a later epic wires the rest in.
export const StockMovement = model
  .define('stock_movement', {
    id: model.id().primaryKey(),
    card_handle: model.text(),
    kind: model.enum([
      'purchase',
      'pull',
      'vault_out',
      'requested',
      'shipped',
      'completed',
      'adjustment',
    ]),
    qty: model.number(), // signed
    ref_id: model.text(), // e.g. the purchase_invoice_line id, for 'purchase'
  })
  .indexes([
    // item-detail history table: newest first, scoped to one handle.
    {
      name: 'IDX_stock_movement_card_handle_created_at',
      on: ['card_handle', 'created_at'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default StockMovement;
