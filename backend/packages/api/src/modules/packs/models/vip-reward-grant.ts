import { model } from '@medusajs/framework/utils';

// One earned reward per (customer, level, kind) — spec §5b. Unique index = the
// idempotency backstop; the high-water mark drives the happy path. Grants are
// advisory + non-fungible until the gated fulfillment phase (§13).
export const VipRewardGrant = model
  .define('vip_reward_grant', {
    id: model.id().primaryKey(),
    customer_id: model.text(),
    level: model.number(),
    kind: model.enum(['voucher', 'frame', 'box', 'prize']),
    payload: model.json(),
    status: model.enum(['granted', 'fulfilled', 'revoked']).default('granted'),
    source_open_id: model.text().nullable(),
  })
  .indexes([
    {
      name: 'UQ_vip_reward_grant_customer_level_kind',
      on: ['customer_id', 'level', 'kind'],
      unique: true,
      where: 'deleted_at IS NULL',
    },
    {
      name: 'IDX_vip_reward_grant_customer',
      on: ['customer_id'],
      where: 'deleted_at IS NULL',
    },
  ]);
export default VipRewardGrant;
