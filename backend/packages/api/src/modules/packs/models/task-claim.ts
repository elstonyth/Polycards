import { model } from '@medusajs/framework/utils';

// One row per CLAIMED task reward — the claim IS the idempotency record
// (progress itself is computed on read, never stored). period_key is the
// referral week's Tuesday ISO for weekly tasks and '' for achievements, so
// the unique index makes "claim once per week" and "claim once ever" the
// same constraint. reward_snapshot freezes what was actually granted;
// claim_ref carries the credit transaction / pull id it minted.
export const TaskClaim = model
  .define('task_claim', {
    id: model.id().primaryKey(),
    customer_id: model.text(),
    task_id: model.text(),
    period_key: model.text().default(''),
    reward_snapshot: model.json().nullable(),
    claim_ref: model.text().nullable(),
  })
  .indexes([
    {
      name: 'IDX_task_claim_customer',
      on: ['customer_id'],
      where: 'deleted_at IS NULL',
    },
    {
      name: 'IDX_task_claim_unique',
      on: ['customer_id', 'task_id', 'period_key'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
  ]);

export default TaskClaim;
