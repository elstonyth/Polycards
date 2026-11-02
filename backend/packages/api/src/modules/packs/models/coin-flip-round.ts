import { model } from '@medusajs/framework/utils';

export const CoinFlipRound = model.define('coin_flip_round', {
  id: model.id().primaryKey(),
  customer_id: model.text(),
  // Null when the flip stakes only tickets (ticket_stake); it can hold both.
  pull_id: model.text().nullable(),
  status: model.enum(['quoted', 'won', 'lost']).default('quoted'),
  stake_cents: model.bigNumber(),
  ticket_stake: model.number().default(0),
  flip_version: model.number(),
  config_revision: model.number(),
  expires_at: model.dateTime(),
  settled_at: model.dateTime().nullable(),
  snapshot: model.json(),
  roll: model.number().nullable(),
  credit_transaction_id: model.text().nullable(),
}).indexes([
  { name: 'IDX_coin_flip_round_customer_created', on: ['customer_id', 'created_at'], where: 'deleted_at IS NULL' },
  { name: 'IDX_coin_flip_round_pull', on: ['pull_id'], where: 'deleted_at IS NULL' },
  { name: 'IDX_coin_flip_round_status_created', on: ['status', 'created_at'], where: 'deleted_at IS NULL' },
]);

export default CoinFlipRound;
