import { model } from '@medusajs/framework/utils';

// lucky_draw_event_result — the outcome of a one_winner event's draw (spec
// 2026-10-30). One row per event (unique index) and never updated or deleted by
// any code path: it is the proof. seed is written here for the first time, at
// draw time, so anyone can re-run the pick from `entries` + `seed` and match
// seed_hash on the event.
//
// winner_customer_id is null when nobody entered. `entries` is the DrawEntrant[]
// in draw order; `excluded` the customer ids refunded as disabled accounts. What
// each prize paid out is on its lucky_draw_result row.
export const LuckyDrawEventResult = model
  .define('lucky_draw_event_result', {
    id: model.id({ prefix: 'lder' }).primaryKey(),
    event_id: model.text(),
    winner_customer_id: model.text().nullable(),
    winner_tickets: model.number().default(0),
    total_tickets: model.number().default(0),
    entrant_count: model.number().default(0),
    ticket_index: model.number().nullable(),
    seed: model.text(),
    entries: model.json(),
    excluded: model.json(),
    drawn_at: model.dateTime(),
  })
  .indexes([
    {
      name: 'UQ_lucky_draw_event_result_event',
      on: ['event_id'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
  ]);

export default LuckyDrawEventResult;
