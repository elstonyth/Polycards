import { model } from '@medusajs/framework/utils';

// One settled reward per (week, customer, kind, card). The row set for a
// week_start IS the "this week is settled" record the hourly job gates on.
// card_id: NOT nullable — '' on credits rows. Postgres treats NULLs as
// DISTINCT in a unique index; a nullable card_id would let the credits row
// insert twice and void the backstop below. The advisory-lock check in
// settleChallengeWinner is the primary guard; this index is the last resort.
export const ChallengePayout = model
  .define('challenge_payout', {
    id: model.id().primaryKey(),
    // Resolved start_utc of the paid week (challengeWeekBounds).
    week_start: model.dateTime(),
    customer_id: model.text(),
    rank: model.number(),
    kind: model.enum(['credits', 'card']),
    card_id: model.text().default(''),
    credits: model.bigNumber().default(0),
    // Audit links: the ledger row / vault pull this payout produced.
    credit_transaction_id: model.text().nullable(),
    pull_id: model.text().nullable(),
    status: model.enum(['granted', 'skipped_no_stock']).default('granted'),
    // { pool_myr, unlocked_stages: number[] } — why this payout happened.
    snapshot: model.json(),
  })
  .indexes([
    {
      name: 'UQ_challenge_payout_week_customer_kind_card',
      on: ['week_start', 'customer_id', 'kind', 'card_id'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
    {
      name: 'IDX_challenge_payout_week',
      on: ['week_start'],
      where: 'deleted_at IS NULL',
    },
  ]);

export default ChallengePayout;
