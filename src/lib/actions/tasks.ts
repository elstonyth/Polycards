'use server';

/**
 * Task hub server actions (spec 2026-08-24 Phase B). Same auth discipline as
 * the wallet actions: the httpOnly JWT is read server-side and sent as an
 * explicit Bearer. Both writes are idempotent on the backend (per-day
 * check-in, per-period claim), so every non-throwing outcome returns a
 * result object for the tab to render, never an exception.
 *
 * Every call goes through the `Store` port (src/lib/store.ts), which owns the
 * cookie read, the bearer, the schema check and the failure log. The two POST
 * bodies are read with `UncheckedSchema` and this file's own types — the port
 * must not reject them at the envelope, because by the time a response comes
 * back the check-in is recorded, the claim is stamped, or the free rip is
 * SPENT, and "try again" over a spent entitlement is the one wrong answer.
 * A bad card inside a spin is caught below by `parseOne(WonCardSchema, …)`.
 */
import { store, type Failure } from '@/lib/store';
import {
  parseOne,
  TaskHubSchema,
  UncheckedSchema,
  WonCardSchema,
  type TaskHub,
} from '@/lib/data/schemas';
import { formatValue } from '@/lib/packs-format';
import { toBuybackOffer } from '@/lib/actions/pack-batch-map';
import type { BuybackOffer, WonCard } from '@/lib/actions/packs';

/** The one failure these actions tell apart: no cookie at all, so the call
 *  never left (`status` is undefined). Everything the backend actually
 *  answered keeps the action's own single sentence, as it always has — this
 *  file has no rules table. */
const loggedOut = (f: Failure): string | null =>
  f.kind === 'unauthenticated' && f.status === undefined
    ? 'Please log in first.'
    : null;

const checkInError = (f: Failure): string =>
  loggedOut(f) ?? 'Could not check in. Please try again.';

export async function getTaskHub(): Promise<TaskHub | null> {
  // Logged out, a failed read, or a hub that did not parse: null, and the tab
  // renders its empty state rather than a half-built one.
  const r = await store.get('/store/tasks', TaskHubSchema);
  return r.ok ? r.data : null;
}

export type CheckInResult =
  { ok: true; checked: boolean } | { ok: false; error: string };

export async function checkInToday(): Promise<CheckInResult> {
  const r = await store.post(
    '/store/tasks/checkin',
    UncheckedSchema,
    undefined,
  );
  if (!r.ok) return { ok: false, error: checkInError(r) };
  const raw = r.data as { checked?: unknown };
  return { ok: true, checked: Boolean(raw.checked) };
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

/** The claim response, as this action asserts it — the same assertion the
 *  pre-port fetch generic carried. `UncheckedSchema` means the port does not
 *  check it: a stamped claim must not read as "try again". */
type RawClaim =
  | {
      claimed: true;
      reward: { type: string; pack_id?: string };
      claimId?: string;
    }
  | { claimed: false; reason: ClaimFailure };

export async function claimTaskReward(taskId: string): Promise<ClaimResult> {
  const r = await store.post(
    `/store/tasks/${encodeURIComponent(taskId)}/claim`,
    UncheckedSchema,
    undefined,
  );
  if (!r.ok) {
    return {
      ok: false,
      error: loggedOut(r) ?? 'Could not claim. Please try again.',
    };
  }
  const raw = r.data as RawClaim;
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
      /** Sell/deliver lock, the BACKEND's answer — never a client constant.
       *  A task reward sells like any pulled card, so this is false on a
       *  current backend; it defaults true when absent so an older backend
       *  can only under-offer, never advertise a sell that 400s. */
      locked: boolean;
      /** The backend's instant sell-back quote — the same shape the paid open
       *  carries, so the reveal is one code path. Null when it sent none. */
      buyback: BuybackOffer | null;
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
  const r = await store.post(
    `/store/tasks/claims/${encodeURIComponent(claimId)}/spin`,
    UncheckedSchema,
    undefined,
  );
  if (!r.ok) {
    return {
      ok: false,
      error: loggedOut(r) ?? 'Could not spin your free rip. Try again.',
    };
  }
  const raw = r.data as {
    redeemed?: boolean;
    reason?: 'not_found' | 'already_redeemed' | 'not_a_pack_reward';
    pullId?: string;
    card?: Record<string, unknown>;
    locked?: unknown;
    buyback?: unknown;
  };
  if (raw.redeemed && typeof raw.pullId === 'string') {
    // The envelope is unchecked (see the header) — validate the CARD so a
    // renamed field can't render "$NaN" or an undefined rarity.
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
      locked: typeof raw.locked === 'boolean' ? raw.locked : true,
      // The same mapping the paid open uses — one offer shape for the reveal.
      buyback: toBuybackOffer(raw.buyback),
      card: {
        id: won.handle,
        name: won.name,
        image: typeof src.image === 'string' ? src.image : '',
        slab_image: typeof src.slab_image === 'string' ? src.slab_image : null,
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
}
