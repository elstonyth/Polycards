'use server';

/**
 * Daily check-in reward server actions (redesign Phase 5).
 *
 * Backend routes:
 *   GET  /store/rewards/daily        → claim state (MYT day, streak, amounts)
 *   POST /store/rewards/daily/claim  → pay today's streak amount into credits
 */
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';
import { friendlyError, isAuthError, type ErrorRule } from '@/lib/errors';
import {
  DailyClaimSchema,
  DailyStatusSchema,
  parseOne,
} from '@/lib/data/schemas';

export type DailyStatus = {
  enabled: boolean;
  /** MYT calendar day, YYYY-MM-DD. */
  day: string;
  claimedToday: boolean;
  /** Streak position today pays (or paid), 1–7. */
  streakDay: number;
  /** MYR amount per streak day, index 0 = day 1. */
  amounts: number[];
  todayAmount: number;
};

export type DailyStatusResult =
  | { ok: true; status: DailyStatus }
  | { ok: false; error: string; needsAuth?: boolean };

export type DailyClaimResult =
  | { ok: true; amount: number; balance: number; streakDay: number }
  | {
      ok: false;
      error: string;
      code?: 'already_claimed' | 'disabled';
      needsAuth?: boolean;
    };

const DAILY_RULES: ErrorRule[] = [
  [
    /too many|rate.?limit|429/i,
    'Too many requests — give it a moment and try again.',
  ],
  [
    /already claimed/i,
    'Today’s reward is already claimed — come back tomorrow.',
  ],
  [/paused/i, 'Daily rewards are paused right now. Check back soon.'],
  [/unauthorized|not authenticated|401/i, 'Please log in to claim rewards.'],
];
const DAILY_FALLBACK = 'Something went wrong. Please try again.';

export async function getDailyStatus(): Promise<DailyStatusResult> {
  const token = await getAuthToken();
  if (!token) {
    return {
      ok: false,
      error: 'Please log in to see your daily reward.',
      needsAuth: true,
    };
  }
  try {
    const raw = await sdk.client.fetch('/store/rewards/daily', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    const parsed = parseOne(DailyStatusSchema, raw);
    if (!parsed) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }
    return { ok: true, status: parsed };
  } catch (error) {
    logger.error('[daily] status failed:', error);
    return {
      ok: false,
      error: friendlyError(error, DAILY_RULES, DAILY_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

export async function claimDailyReward(): Promise<DailyClaimResult> {
  const token = await getAuthToken();
  if (!token) {
    return {
      ok: false,
      error: 'Please log in to claim rewards.',
      needsAuth: true,
    };
  }
  try {
    const raw = await sdk.client.fetch('/store/rewards/daily/claim', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    const parsed = parseOne(DailyClaimSchema, raw);
    if (!parsed) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }
    return {
      ok: true,
      amount: parsed.amount,
      balance: parsed.balance,
      streakDay: parsed.streakDay,
    };
  } catch (error) {
    logger.error('[daily] claim failed:', error);
    const message = friendlyError(error, DAILY_RULES, DAILY_FALLBACK);
    const text = error instanceof Error ? error.message : String(error);
    const code = /already.claimed/i.test(text)
      ? ('already_claimed' as const)
      : /paused|disabled/i.test(text)
        ? ('disabled' as const)
        : undefined;
    return {
      ok: false,
      error: message,
      code,
      needsAuth: isAuthError(error),
    };
  }
}
