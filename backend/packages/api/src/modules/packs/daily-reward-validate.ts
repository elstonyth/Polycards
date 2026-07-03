import { MedusaError } from '@medusajs/framework/utils';
import { MAX_REWARD_CREDIT_MYR } from './reward-pool-validate';

/** Streak length — the calendar wraps after day 7. */
export const DAILY_STREAK_DAYS = 7;

/** Defaults used until an admin authors the singleton row (MYR, day 1 → 7). */
export const DEFAULT_DAILY_AMOUNTS: readonly number[] = [1, 2, 3, 4, 5, 6, 10];

export type DailyRewardSettingsView = {
  enabled: boolean;
  /** Seven MYR amounts, streak day 1 → 7. */
  amounts: number[];
};

export type DailyRewardPatch = {
  enabled?: boolean;
  amounts?: number[];
};

/**
 * Validate an admin daily-reward-settings patch. Amounts must be exactly 7
 * finite positive MYR values (whole cents), each ≤ MAX_REWARD_CREDIT_MYR —
 * the same defense-in-depth ceiling the reward-pool credits enforce.
 */
export function validateDailyRewardPatch(raw: unknown): DailyRewardPatch {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Body must be an object.',
    );
  }
  const body = raw as Record<string, unknown>;
  const patch: DailyRewardPatch = {};

  if ('enabled' in body) {
    if (typeof body.enabled !== 'boolean') {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        'enabled must be a boolean.',
      );
    }
    patch.enabled = body.enabled;
  }

  if ('amounts' in body) {
    const amounts = body.amounts;
    if (!Array.isArray(amounts) || amounts.length !== DAILY_STREAK_DAYS) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `amounts must be an array of exactly ${DAILY_STREAK_DAYS} MYR values.`,
      );
    }
    const parsed = amounts.map((value, i) => {
      if (typeof value !== 'number') {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `amounts[${i}] must be a number.`,
        );
      }
      const n = value;
      if (!Number.isFinite(n) || n <= 0) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `amounts[${i}] must be a positive number.`,
        );
      }
      if (n > MAX_REWARD_CREDIT_MYR) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `amounts[${i}] must be at most ${MAX_REWARD_CREDIT_MYR} MYR.`,
        );
      }
      if (Math.abs(n * 100 - Math.round(n * 100)) > 1e-6) {
        throw new MedusaError(
          MedusaError.Types.INVALID_DATA,
          `amounts[${i}] must be whole cents.`,
        );
      }
      return n;
    });
    patch.amounts = parsed;
  }

  if (patch.enabled === undefined && patch.amounts === undefined) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'Provide enabled and/or amounts.',
    );
  }
  return patch;
}

/**
 * Coerce a stored `{ days: number[7] }` JSON value back to a safe 7-array
 * (or defaults when absent/malformed).
 */
export function coerceStoredAmounts(raw: unknown): number[] {
  const days =
    raw != null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).days
      : undefined;
  if (Array.isArray(days) && days.length === DAILY_STREAK_DAYS) {
    const nums = days.map(Number);
    if (nums.every((n) => Number.isFinite(n) && n > 0)) return nums;
  }
  return [...DEFAULT_DAILY_AMOUNTS];
}
