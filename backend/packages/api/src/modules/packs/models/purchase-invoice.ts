import { model } from '@medusajs/framework/utils';

// PurchaseInvoice — an immutable receiving record (POLYCARD-BACK §3.5). D7:
// `supplier` answers the doc's "PURCHASE WITH?" (source/vendor, not a payment
// method). Corrections are NEVER edits — they are a second invoice with
// negative-qty lines that mirror the original 1:1 on card_handle + unit_cost
// (enforced in api/admin/purchase-invoices/route.ts), which is what keeps the
// D8 weighted average honest. agent_user_id is server-derived
// (auth_context.actor_id), never client-supplied. display_no is a
// self-contained Postgres sequence (PI-00001, see purchase_invoice_seq below)
// — NOT coupled to Epic 4's ledger display-id generator (TP26Q3A0001-style,
// MYT-scoped). If the operator later wants invoice numbers ledger-chained,
// that's a follow-up migration on this column once Epic 4 exists; do not
// wire it in from here.
export const PurchaseInvoice = model
  .define('purchase_invoice', {
    id: model.id().primaryKey(),
    display_no: model.text().unique(), // "PI-00001" — see purchase_invoice_seq
    date: model.dateTime(), // operator-entered invoice date; may differ from created_at
    supplier: model.text(),
    agent_user_id: model.text(),
    reverses_invoice_id: model.text().nullable(),
  })
  .indexes([
    {
      name: 'IDX_purchase_invoice_created_at',
      on: ['created_at'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default PurchaseInvoice;
