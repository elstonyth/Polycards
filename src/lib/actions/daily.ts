'use server';

/**
 * SUSPENDED 2026-07-29 — the `/daily` route was deleted with the reward
 * surfaces (docs/superpowers/specs/2026-07-29-suspend-vip-referral-surfaces-design.md).
 * Kept unreferenced, not deleted, so un-suspending is a revert rather than a
 * rewrite; the backend routes these call are all still live.
 *
 * The daily-BOX half (getDaily's `box`, `drawDailyBox`, the ship-prize list)
 * was removed outright 2026-08-25 with the box itself — that is a retirement,
 * not a suspension, so there is nothing to revert to. What remains is the VIP
 * voucher/frame grant surface.
 *
 * Backend routes:
 *   GET  /store/daily                    — voucher/frame grants
 *   POST /store/rewards/claim/:grantId   — claim a voucher or frame grant
 *   POST /store/rewards/withdraw         — ship a vaulted prize pull
 */
import { sdk } from '@/lib/medusa';
import { logger } from '@/lib/logger';
import { getAuthToken } from '@/lib/data/customer';
import { friendlyError, isAuthError, type ErrorRule } from '@/lib/errors';
import {
  parseList,
  parseOne,
  RewardGrantSchema,
  ClaimGrantSchema,
  DailyStateSchema,
  WithdrawPrizeSchema,
  WithdrawAddressSchema,
  type WithdrawAddressInput,
} from '@/lib/data/schemas';

// ---- types ------------------------------------------------------------------

export type VoucherGrant = {
  id: string;
  kind: 'voucher' | 'frame';
  level: number;
  /** 'ladder' = one-time level-up reward. 'box' only ever appears on rows
   *  minted before the daily box was removed. */
  origin: 'ladder' | 'box';
  amountMyr?: number;
  grantedAt: string;
};

export type DailyState = {
  redemptionEnabled: boolean;
  vouchers: { claimable: VoucherGrant[]; claimed: VoucherGrant[] };
};

export type DailyResult =
  | { ok: true; state: DailyState }
  | { ok: false; error: string; needsAuth?: boolean };

export type ClaimGrantResult =
  | { ok: true; claimed: boolean; kind: string }
  | { ok: false; error: string; needsAuth?: boolean };

export type WithdrawPrizeResult =
  | { ok: true; status: 'requested' | 'capped' | 'invalid' }
  | { ok: false; error: string; needsAuth?: boolean };

// ---- error rules ------------------------------------------------------------

const DAILY_RULES: ErrorRule[] = [
  [
    /too many|rate.?limit|429/i,
    'Too many requests — wait a moment and try again.',
  ],
  [
    /unauthorized|not authenticated|401/i,
    'Please log in to view your rewards.',
  ],
  [/not found|404/i, 'Reward not found.'],
  // Only the redemption gate's own message — not every 403 (an ownership/forbidden
  // 403 should fall through to the generic fallback, not claim the gate is off).
  [
    /not enabled yet|redemption is not enabled|reward redemption/i,
    'Reward redemption is not enabled yet.',
  ],
];
const DAILY_FALLBACK = 'Something went wrong. Please try again.';

// ---- mapping helpers ----------------------------------------------------------

const toVoucherGrant = (
  g: ReturnType<typeof RewardGrantSchema.parse>,
): VoucherGrant => ({
  id: g.id,
  kind: g.kind as 'voucher' | 'frame',
  level: g.level ?? 0,
  origin: g.origin ?? 'ladder',
  amountMyr: (g.payload as { amount_myr?: number } | null | undefined)
    ?.amount_myr,
  grantedAt: g.granted_at,
});

// ---- actions ----------------------------------------------------------------

/** Load the customer's voucher/frame grant state in one call. */
export async function getDaily(): Promise<DailyResult> {
  const token = await getAuthToken();
  if (!token) {
    return {
      ok: false,
      error: 'Please log in to view your rewards.',
      needsAuth: true,
    };
  }
  try {
    const raw = await sdk.client.fetch('/store/daily', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });

    const parsed = parseOne(DailyStateSchema, raw);
    if (!parsed) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }

    const vouchers = {
      claimable: parseList(RewardGrantSchema, parsed.vouchers.claimable).map(
        toVoucherGrant,
      ),
      claimed: parseList(RewardGrantSchema, parsed.vouchers.claimed).map(
        toVoucherGrant,
      ),
    };

    return {
      ok: true,
      state: {
        redemptionEnabled: parsed.redemption_enabled,
        vouchers,
      },
    };
  } catch (error) {
    logger.error('[daily] load failed:', error);
    return {
      ok: false,
      error: friendlyError(error, DAILY_RULES, DAILY_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

/** Claim a voucher or frame grant. Only for kind='voucher'|'frame'. */
export async function claimVoucher(grantId: string): Promise<ClaimGrantResult> {
  if (typeof grantId !== 'string' || grantId.trim() === '') {
    return { ok: false, error: 'Invalid grant.' };
  }
  const token = await getAuthToken();
  if (!token) {
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  }
  try {
    const parsed = parseOne(
      ClaimGrantSchema,
      await sdk.client.fetch(
        `/store/rewards/claim/${encodeURIComponent(grantId)}`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: {},
        },
      ),
    );
    if (!parsed) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }
    return { ok: true, claimed: parsed.claimed, kind: parsed.kind };
  } catch (error) {
    logger.error(`[daily] claim failed for '${grantId}':`, error);
    return {
      ok: false,
      error: friendlyError(error, DAILY_RULES, DAILY_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

// WithdrawAddressSchema + WithdrawAddressInput live in @/lib/data/schemas (the
// app's sole `zod` importer — eslint no-restricted-imports forbids importing zod
// here). Consumers import the type straight from schemas; a "use server" file
// can only export async functions, so it must NOT re-export it.

/** Request shipping for a vaulted prize pull. Not env-gated (balance-neutral). */
export async function withdrawPrize(
  pullId: string,
  address: WithdrawAddressInput,
): Promise<WithdrawPrizeResult> {
  if (typeof pullId !== 'string' || pullId.trim() === '') {
    return { ok: false, error: 'Invalid prize.' };
  }
  const addrResult = WithdrawAddressSchema.safeParse(address);
  if (!addrResult.success) {
    return { ok: false, error: 'Please fill in all address fields.' };
  }
  const token = await getAuthToken();
  if (!token) {
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  }
  try {
    const parsed = parseOne(
      WithdrawPrizeSchema,
      await sdk.client.fetch('/store/rewards/withdraw', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: { pull_id: pullId, address: addrResult.data },
      }),
    );
    if (!parsed) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }
    return { ok: true, status: parsed.status };
  } catch (error) {
    logger.error(`[daily] withdraw failed for '${pullId}':`, error);
    return {
      ok: false,
      error: friendlyError(error, DAILY_RULES, DAILY_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}
