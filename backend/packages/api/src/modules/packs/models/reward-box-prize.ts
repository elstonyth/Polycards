import { model } from '@medusajs/framework/utils';

// weight is integer units (1 unit = 0.0001%) normalized at save time via @acme/odds-math computeOdds
// (Σ == 10000 per box). locked mirrors pack-odds semantics: admin-pinned pct.
// payload: credit/voucher {amount_myr} · product {product_handle, qty} · nothing {}
export const RewardBoxPrize = model
  .define('reward_box_prize', {
    id: model.id().primaryKey(),
    box_id: model.text(),
    kind: model.enum(['credit', 'product', 'voucher', 'nothing']),
    payload: model.json(),
    weight: model.number(),
    locked: model.boolean().default(false),
  })
  .indexes([
    { name: 'IDX_reward_box_prize_box', on: ['box_id'], where: 'deleted_at IS NULL' },
  ]);
export default RewardBoxPrize;
