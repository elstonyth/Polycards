import { model } from '@medusajs/framework/utils';

// rewards_settings — singleton reward globals, admin-editable (forward-only).
// One row; the service reads the first row and falls back to defaults when
// absent.
export const RewardsSettings = model.define('rewards_settings', {
  id: model.id().primaryKey(),
  // Max reward prize withdrawals (shipping requests) per customer per day.
  withdrawals_per_day: model.number().default(1),
});

export default RewardsSettings;
