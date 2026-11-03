import { model } from '@medusajs/framework/utils';

// GoodsReceiveNoteLine — one card line on a GoodsReceiveNote. Mirrors
// PurchaseInvoiceLine minus the cost columns: card_handle is the
// Product/Card business key, card_name and fmv_snapshot are taken at receive
// time, qty is SIGNED (negative only on a reversal GRN's lines). A row is never
// updated: an edit of an open note soft-deletes its lines and writes new ones,
// so readers must skip deleted_at rows.
export const GoodsReceiveNoteLine = model
  .define('goods_receive_note_line', {
    id: model.id().primaryKey(),
    grn_id: model.text(),
    card_handle: model.text(),
    card_name: model.text(),
    fmv_snapshot: model.bigNumber(), // MYR, set when the line is written
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
