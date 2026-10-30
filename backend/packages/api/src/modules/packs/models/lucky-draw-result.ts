import { model } from '@medusajs/framework/utils';

// lucky_draw_result — the outcome of one prize's draw. One row per prize
// (unique index) and never updated or deleted by any code path: it is the
// proof. seed is written here for the first time, at draw time, so anyone can
// re-run the pick from `entries` + `seed` and match seed_hash on the prize.
//
// winner_customer_id is null when nobody entered. `entries` is the DrawEntrant[]
// in draw order; `excluded` the customer ids refunded as disabled accounts.
//
// A one_winner draw also writes one row here per prize (the event's winner, the
// same seed, empty `entries`), so payout and history keep working per prize. The
// proof of that draw, with the frozen entries, is lucky_draw_event_result.
export const LuckyDrawResult = model
  .define('lucky_draw_result', {
    id: model.id({ prefix: 'ldrs' }).primaryKey(),
    prize_id: model.text(),
    winner_customer_id: model.text().nullable(),
    winner_tickets: model.number().default(0),
    total_tickets: model.number().default(0),
    entrant_count: model.number().default(0),
    ticket_index: model.number().nullable(),
    seed: model.text(),
    entries: model.json(),
    excluded: model.json(),
    // Audit links: the ledger row / vault pull the prize minted.
    credit_transaction_id: model.text().nullable(),
    pull_id: model.text().nullable(),
    drawn_at: model.dateTime(),
  })
  .indexes([
    {
      name: 'UQ_lucky_draw_result_prize',
      on: ['prize_id'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
  ]);

export default LuckyDrawResult;
