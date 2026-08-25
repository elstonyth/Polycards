import { MedusaError } from '@medusajs/framework/utils';

export type RewardsSettingsPatch = {
  withdrawals_per_day?: number;
};

export type RewardsSettingsView = {
  withdrawals_per_day: number;
};

const bad = (m: string): never => {
  throw new MedusaError(MedusaError.Types.INVALID_DATA, m);
};

// Validate an admin rewards-settings patch — reject the obviously-broken config
// before write.
export function validateRewardsPatch(raw: unknown): RewardsSettingsPatch {
  if (!raw || typeof raw !== 'object') bad('Body must be an object.');
  const b = raw as Record<string, unknown>;
  const out: RewardsSettingsPatch = {};

  if (b.withdrawals_per_day !== undefined) {
    if (typeof b.withdrawals_per_day !== 'number')
      bad('withdrawals_per_day must be an integer >= 1.');
    const v = b.withdrawals_per_day as number;
    if (!Number.isSafeInteger(v) || v < 1)
      bad('withdrawals_per_day must be an integer >= 1.');
    out.withdrawals_per_day = v;
  }
  if (Object.keys(out).length === 0) bad('No valid settings to update.');
  return out;
}
