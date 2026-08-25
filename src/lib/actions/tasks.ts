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
import {
  parseOne,
  TaskHubSchema,
  WonCardSchema,
  type TaskHub,
} from '@/lib/data/schemas';
import { formatValue } from '@/lib/packs-format';
import type { WonCard } from '@/lib/actions/packs';

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
  'not_found' | 'not_completed' | 'already_claimed' | 'window_closed';

export type ClaimResult =
  | {
      ok: true;
      claimed: true;
      rewardType: string;
      /** Present for a PACK reward: the entitlement the slot spends. The tab
       *  sends the player straight to /slots/<packId>/spin with it — claiming
       *  grants the free rip, spinning is how they take it. */
      spin: { claimId: string; packId: string } | null;
    }
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
      | {
          claimed: true;
          reward: { type: string; pack_id?: string };
          claimId?: string;
        }
      | { claimed: false; reason: ClaimFailure }
    >(`/store/tasks/${encodeURIComponent(taskId)}/claim`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (raw.claimed) {
      const spin =
        raw.reward.type === 'pack' &&
        typeof raw.claimId === 'string' &&
        typeof raw.reward.pack_id === 'string'
          ? { claimId: raw.claimId, packId: raw.reward.pack_id }
          : null;
      return { ok: true, claimed: true, rewardType: raw.reward.type, spin };
    }
    return { ok: true, claimed: false, reason: raw.reason };
  } catch (error) {
    logger.error('[tasks] claim failed:', error);
    return { ok: false, error: 'Could not claim. Please try again.' };
  }
}

/** What the slot gets back from spending a free rip. Mirrors the paid open's
 *  envelope closely enough that the reveal is one code path. */
export type SpinTaskRewardResult =
  | {
      ok: true;
      redeemed: true;
      pullId: string;
      /** Already mapped to the reveal's shape — the slot is a client component
       *  and must not reach for the zod schemas or the money formatter. */
      card: WonCard;
      /** Raw USD FMV, for the reveal's display fallback. */
      marketValue: number;
    }
  | {
      ok: true;
      redeemed: false;
      reason: 'not_found' | 'already_redeemed' | 'not_a_pack_reward';
    }
  | { ok: false; error: string };

/**
 * Spend a free-rip entitlement — the slot's Spin button for a task reward.
 *
 * The whole redemption (roll → pull → stamp the claim) commits in ONE backend
 * transaction, which is what makes closing the tab mid-spin safe: either the
 * request never landed and the entitlement is still there to spin again, or it
 * committed and the card is in the vault. `already_redeemed` is therefore a
 * SUCCESS from the player's side — it means a previous attempt did land — and
 * the caller should show them the card rather than an error.
 */
export async function spinTaskReward(
  claimId: string,
): Promise<SpinTaskRewardResult> {
  if (typeof claimId !== 'string' || claimId.trim() === '') {
    return { ok: false, error: 'Invalid free rip.' };
  }
  const token = await getAuthToken();
  if (!token) return { ok: false, error: 'Please log in first.' };
  try {
    const raw = await sdk.client.fetch<{
      redeemed?: boolean;
      reason?: 'not_found' | 'already_redeemed' | 'not_a_pack_reward';
      pullId?: string;
      card?: Record<string, unknown>;
    }>(`/store/tasks/claims/${encodeURIComponent(claimId)}/spin`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (raw.redeemed && typeof raw.pullId === 'string') {
      // The fetch generic is an assertion, not a runtime guard — validate the
      // shape so a renamed field can't render "$NaN" or an undefined rarity.
      const won = parseOne(WonCardSchema, raw.card);
      if (!won) {
        return { ok: false, error: 'Got an unexpected response. Try again.' };
      }
      const src = (raw.card ?? {}) as Record<string, unknown>;
      return {
        ok: true,
        redeemed: true,
        pullId: raw.pullId,
        marketValue: won.market_value,
        card: {
          id: won.handle,
          name: won.name,
          image: typeof src.image === 'string' ? src.image : '',
          slab_image:
            typeof src.slab_image === 'string' ? src.slab_image : null,
          // Raw USD must never render behind "RM" — an older backend without
          // marketPriceMyr shows "—" rather than a fake price.
          value:
            won.marketPriceMyr != null ? formatValue(won.marketPriceMyr) : '—',
          rarity: won.rarity as WonCard['rarity'],
          pokemon_dex: won.pokemon_dex ?? null,
          sprite_image: won.sprite_image ?? null,
          marketPriceMyr: won.marketPriceMyr ?? null,
        },
      };
    }
    return {
      ok: true,
      redeemed: false,
      reason: raw.reason ?? 'not_found',
    };
  } catch (error) {
    logger.error('[tasks] free rip failed:', error);
    return { ok: false, error: 'Could not spin your free rip. Try again.' };
  }
}
