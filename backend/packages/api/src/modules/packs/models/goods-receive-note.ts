import { model } from '@medusajs/framework/utils';

// GoodsReceiveNote — cards that arrived BEFORE the supplier's invoice did
// (operator spec 2026-10-28). Same immutable shape as PurchaseInvoice: a
// mistake is fixed by a reversal GRN (reverses_grn_id, negative-qty mirror of
// every line), never an edit. No cost: cost arrives with the invoice, which is
// written later through "transfer from goods receive note"
// (purchase_invoice.from_grn_id). Whether a GRN was transferred is read from
// that column — there is deliberately no flag here to drift out of step.
// display_no comes from its own Postgres sequence (GRN-00001, see
// goods_receive_note_seq in Migration20261028150000).
export const GoodsReceiveNote = model
  .define('goods_receive_note', {
    id: model.id().primaryKey(),
    display_no: model.text().unique(),
    date: model.dateTime(), // operator-entered receive date
    supplier: model.text(),
    agent_user_id: model.text(), // server-derived (auth_context.actor_id)
    reverses_grn_id: model.text().nullable(),
  })
  .indexes([
    {
      name: 'IDX_goods_receive_note_created_at',
      on: ['created_at'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default GoodsReceiveNote;
