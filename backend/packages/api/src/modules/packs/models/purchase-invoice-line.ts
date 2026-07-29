import { model } from '@medusajs/framework/utils';

// PurchaseInvoiceLine — one SKU line on a PurchaseInvoice. `card_handle` is
// the Product/Card business key (=== Card.handle === Product.handle) — a
// line MAY reference a product with no Card row yet (Inventory §3.3 shows
// both). fmv_snapshot freezes the market value AT PURCHASE TIME in MYR (never
// recomputed later). qty is SIGNED: negative on a reversal line (D8's
// "reversing invoice" correction) — sign lives in qty only, so unit_cost /
// fmv_snapshot stay positive and read the same as the line they undo.
export const PurchaseInvoiceLine = model
  .define('purchase_invoice_line', {
    id: model.id().primaryKey(),
    invoice_id: model.text(),
    card_handle: model.text(),
    card_name: model.text(), // snapshot — a later card rename never rewrites history
    fmv_snapshot: model.bigNumber(), // MYR, frozen at create
    qty: model.number(), // signed integer
    unit_cost: model.bigNumber(), // MYR, always positive
    // qty * unit_cost — negative on a reversal line. Enforced in the DB by
    // purchase_invoice_line_line_total_check (Migration20260729020000), which
    // is hand-written like every other check in this module rather than
    // declared here via .checks().
    line_total: model.bigNumber(),
  })
  .indexes([
    {
      name: 'IDX_purchase_invoice_line_invoice_id',
      on: ['invoice_id'],
      where: 'deleted_at IS NULL',
    },
    // D8 weighted-average cost reads every line for a handle across ALL
    // invoices — this is the query the Inventory "cost" column runs.
    {
      name: 'IDX_purchase_invoice_line_card_handle',
      on: ['card_handle'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default PurchaseInvoiceLine;
