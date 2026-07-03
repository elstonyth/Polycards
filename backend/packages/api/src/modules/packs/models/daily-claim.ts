import { model } from '@medusajs/framework/utils';

// DailyClaim — one row per customer per MYT calendar day (redesign Phase 5).
// The claim engine (claimDaily) checks-then-inserts under the per-customer
// `credit:` advisory lock; the unique index is the DB backstop so a customer
// can never record two claims for the same day whatever races the API loses.
// The credit itself is idempotent separately (`daily:${customer}:${day}`).
export const DailyClaim = model
  .define('daily_claim', {
    id: model.id().primaryKey(),
    customer_id: model.text(),
    // MYT (Asia/Kuala_Lumpur) calendar day, YYYY-MM-DD.
    claim_day: model.text(),
    // Position in the 7-day streak this claim paid (1-7; wraps back to 1).
    streak_day: model.number(),
    // MYR decimal credited (mirrors credit_transaction.amount units).
    amount: model.bigNumber(),
  })
  .indexes([
    {
      name: 'UQ_daily_claim_customer_day',
      on: ['customer_id', 'claim_day'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
  ]);

export default DailyClaim;
