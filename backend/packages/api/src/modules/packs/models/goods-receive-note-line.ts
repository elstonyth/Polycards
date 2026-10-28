import { model } from '@medusajs/framework/utils';

// GoodsReceiveNoteLine — one card line on a GoodsReceiveNote. Mirrors
// PurchaseInvoiceLine minus the cost columns: card_handle is the
// Product/Card business key, card_name and fmv_snapshot are frozen at receive
// time, qty is SIGNED (negative only on a reversal GRN's lines).
export const GoodsReceiveNoteLine = model
  .define('goods_receive_note_line', {
    id: model.id().primaryKey(),
    grn_id: model.text(),
    card_handle: model.text(),
    card_name: model.text(),
    fmv_snapshot: model.bigNumber(), // MYR, frozen at create
    qty: model.number(), // signed integer
  })
  .indexes([
    {
      name: 'IDX_goods_receive_note_line_grn_id',
      on: ['grn_id'],
      where: 'deleted_at IS NULL',
    },
    // On hand sums every line for a handle across all GRNs.
    {
      name: 'IDX_goods_receive_note_line_card_handle',
      on: ['card_handle'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default GoodsReceiveNoteLine;
