import { model } from '@medusajs/framework/utils';

export const CoinFlipConfig = model.define('coin_flip_config', {
  id: model.id().primaryKey(),
  enabled: model.boolean().default(false),
  // Retained for old schema compatibility; stake caps are no longer used.
  max_stake_cents: model.number().nullable(),
  win_units: model.number().nullable(),
  win_units_2: model.number().nullable(),
  win_units_3: model.number().nullable(),
  published_win_units: model.number().nullable(),
  revision: model.number().default(0),
});

export default CoinFlipConfig;
