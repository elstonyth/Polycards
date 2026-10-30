import { model } from '@medusajs/framework/utils';

// lucky_draw_entry — tickets a customer put on one prize (a per_prize event) or
// on a whole event (a one_winner event). Exactly one of prize_id / event_id is
// set: a hand-written CHECK holds that (Migration20261030110000). Each enter
// writes a row (and a negative lucky_draw_ticket ledger row); the draw sums them
// per customer. Rows are removed from the draw only by a refund, never edited.
export const LuckyDrawEntry = model
  .define('lucky_draw_entry', {
    id: model.id({ prefix: 'lden' }).primaryKey(),
    prize_id: model.text().nullable(),
    event_id: model.text().nullable(),
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
      name: 'IDX_lucky_draw_entry_event',
      on: ['event_id'],
      where: 'deleted_at IS NULL',
    },
    {
      name: 'IDX_lucky_draw_entry_customer',
      on: ['customer_id'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default LuckyDrawEntry;
