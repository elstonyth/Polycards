import { model } from '@medusajs/framework/utils';

// daily_reward_settings — singleton config for the daily check-in reward,
// admin-editable (same singleton pattern as rewards_settings). One row; the
// service reads the first row and falls back to defaults when absent.
export const DailyRewardSettings = model.define('daily_reward_settings', {
  id: model.id().primaryKey(),
  // Kill switch — claims 409 while off; the storefront tab shows a paused state.
  enabled: model.boolean().default(true),
  // Seven MYR amounts, streak day 1 → 7, stored as `{ days: number[7] }`
  // (object wrapper — the DML json type is Record-shaped). Validated by
  // validateDailyRewardPatch (positive, ≤ MAX_REWARD_CREDIT_MYR each).
  amounts: model.json().nullable(),
});

export default DailyRewardSettings;
