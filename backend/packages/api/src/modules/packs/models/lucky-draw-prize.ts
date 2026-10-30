import { model } from '@medusajs/framework/utils';

// lucky_draw_prize — one prize of an event, drawn once at draw_at.
//
// Fairness: the row never holds the seed. seed_nonce is random and seed_hash is
// the public commitment; the seed itself is deriveDrawSeed(secret, seed_nonce),
// recomputed at draw time and written only into lucky_draw_result. Staff tools
// and the desk bots can read this table, so a stored seed would leak the winner
// before the draw.
//
// On a one_winner event the event holds the commitment: seed_nonce and seed_hash
// stay null here, and draw_at is the event's end.
//
// Exactly one of card_handle / credit_myr is set, per `kind`.
export const LuckyDrawPrize = model
  .define('lucky_draw_prize', {
    id: model.id({ prefix: 'ldpz' }).primaryKey(),
    event_id: model.text(),
    kind: model.enum(['card', 'credit']),
    card_handle: model.text().nullable(),
    credit_myr: model.bigNumber().nullable(),
    title: model.text(),
    image_url: model.text().nullable(),
    sort: model.number().default(0),
    draw_at: model.dateTime(),
    seed_nonce: model.text().nullable(),
    seed_hash: model.text().nullable(),
    cancelled_at: model.dateTime().nullable(),
  })
  .indexes([
    {
      name: 'IDX_lucky_draw_prize_event',
      on: ['event_id'],
      where: 'deleted_at IS NULL',
    },
    // The draw job's read: prizes still waiting for their draw.
    {
      name: 'IDX_lucky_draw_prize_draw_at',
      on: ['draw_at'],
      where: 'cancelled_at IS NULL AND deleted_at IS NULL',
    },
  ]);

export default LuckyDrawPrize;
