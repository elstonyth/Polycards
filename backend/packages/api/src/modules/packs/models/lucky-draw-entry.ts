import { model } from '@medusajs/framework/utils';

// lucky_draw_entry — tickets a customer put on one prize. Each enter writes a
// row (and a negative lucky_draw_ticket ledger row); the draw sums them per
// customer. Rows are removed from the draw only by a refund, never edited.
export const LuckyDrawEntry = model
  .define('lucky_draw_entry', {
    id: model.id({ prefix: 'lden' }).primaryKey(),
    prize_id: model.text(),
    customer_id: model.text(),
    tickets: model.number(),
  })
  .indexes([
    {
      name: 'IDX_lucky_draw_entry_prize',
      on: ['prize_id'],
      where: 'deleted_at IS NULL',
    },
    {
      name: 'IDX_lucky_draw_entry_customer',
      on: ['customer_id'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default LuckyDrawEntry;
