'use server';

/**
 * Task hub server actions (spec 2026-08-24 Phase B). Same auth discipline as
 * the wallet actions: the httpOnly JWT is read server-side and sent as an
 * explicit Bearer. Both writes are idempotent on the backend (per-day
 * check-in, per-period claim), so every non-throwing outcome returns a
 * result object for the tab to render, never an exception.
 */
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';
import { parseOne, TaskHubSchema, type TaskHub } from '@/lib/data/schemas';

export async function getTaskHub(): Promise<TaskHub | null> {
  const token = await getAuthToken();
  if (!token) return null;
  try {
    const raw = await sdk.client.fetch('/store/tasks', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    return parseOne(TaskHubSchema, raw);
  } catch (error) {
    logger.error('[tasks] hub load failed:', error);
    return null;
  }
}

export type CheckInResult =
  { ok: true; checked: boolean } | { ok: false; error: string };

export async function checkInToday(): Promise<CheckInResult> {
  const token = await getAuthToken();
  if (!token) return { ok: false, error: 'Please log in first.' };
  try {
    const raw = await sdk.client.fetch<{ checked: boolean }>(
      '/store/tasks/checkin',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        cache: 'no-store',
      },
    );
    return { ok: true, checked: Boolean(raw.checked) };
  } catch (error) {
    logger.error('[tasks] check-in failed:', error);
    return { ok: false, error: 'Could not check in. Please try again.' };
  }
}

/** Why a claim did not pay. `window_closed` is its own case on purpose: a
 *  scheduled task can end between the page load and the tap, and answering
 *  "not completed yet" over a finished 3/3 row is the worst thing to say. */
export type ClaimFailure =
  | 'not_found'
  | 'not_completed'
  | 'already_claimed'
  | 'window_closed';

export type ClaimResult =
  | { ok: true; claimed: true; rewardType: string }
  | {
      ok: true;
      claimed: false;
      reason: ClaimFailure;
    }
  | { ok: false; error: string };

export async function claimTaskReward(taskId: string): Promise<ClaimResult> {
  const token = await getAuthToken();
  if (!token) return { ok: false, error: 'Please log in first.' };
  try {
    const raw = await sdk.client.fetch<
      | { claimed: true; reward: { type: string } }
      | { claimed: false; reason: ClaimFailure }
    >(`/store/tasks/${encodeURIComponent(taskId)}/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (raw.claimed) {
      return { ok: true, claimed: true, rewardType: raw.reward.type };
    }
    return { ok: true, claimed: false, reason: raw.reason };
  } catch (error) {
    logger.error('[tasks] claim failed:', error);
    return { ok: false, error: 'Could not claim. Please try again.' };
  }
}
