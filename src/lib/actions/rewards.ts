'use server';

/**
 * My Rewards server actions — calls the 4 store/rewards endpoints.
 * JWT stays in the httpOnly cookie; the backend derives customer id from
 * the bearer token alone (never sent from the client).
 *
 * Backend routes:
 *   GET  /store/rewards                  — grants + draw_state + vaulted prizes
 *   POST /store/rewards/claim/:grantId   — claim a voucher or frame grant
 *   POST /store/rewards/draw             — daily-box draw
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
  RewardDrawStateSchema,
  RewardPrizeSchema,
  RewardsEnvelopeSchema,
  ClaimGrantSchema,
  DrawBoxSchema,
  WithdrawPrizeSchema,
  WithdrawAddressSchema,
  type WithdrawAddressInput,
} from '@/lib/data/schemas';

// ---- types ------------------------------------------------------------------

export type RewardGrant = {
  id: string;
  kind: 'voucher' | 'frame' | 'box' | 'prize';
  status: 'granted' | 'fulfilled' | 'revoked';
  payload: Record<string, unknown> | null;
  grantedAt: string;
};

export type RewardDrawState = {
  drawsToday: number;
  drawsPerDay: number;
  poolEnabled: boolean;
  tier: string;
};

export type RewardPrize = {
  pullId: string;
  prizeKind: 'product' | 'credit' | 'nothing';
  prizeSnapshot: Record<string, unknown> | null;
  status: string;
  drawDay: string;
};

export type DrawPrize = {
  kind: 'product' | 'credit' | 'nothing';
  title?: string;
  image?: string;
  amountMyr?: number;
  productHandle?: string;
};

export type RewardsResult =
  | {
      ok: true;
      grants: RewardGrant[];
      drawState: RewardDrawState | null;
      prizes: RewardPrize[];
      redemptionEnabled: boolean;
    }
  | { ok: false; error: string; needsAuth?: boolean };

export type ClaimGrantResult =
  | { ok: true; claimed: boolean; kind: string }
  | { ok: false; error: string; needsAuth?: boolean };

export type DrawBoxResult =
  | { ok: true; status: 'drawn' | 'unavailable' | 'capped'; prize?: DrawPrize }
  | { ok: false; error: string; needsAuth?: boolean };

export type WithdrawPrizeResult =
  | { ok: true; status: 'requested' | 'capped' | 'invalid' }
  | { ok: false; error: string; needsAuth?: boolean };

// ---- error rules ------------------------------------------------------------

const REWARDS_RULES: ErrorRule[] = [
  [
    /too many|rate.?limit|429/i,
    'Too many requests — wait a moment and try again.',
  ],
  [
    /unauthorized|not authenticated|401/i,
    'Please log in to view your rewards.',
  ],
  [/not found|404/i, 'Reward not found.'],
  [/gate|disabled|forbidden|403/i, 'Reward redemption is not enabled yet.'],
];
const REWARDS_FALLBACK = 'Something went wrong. Please try again.';

// ---- actions ----------------------------------------------------------------

/** Load all reward data for the page in one call. */
export async function getRewards(): Promise<RewardsResult> {
  const token = await getAuthToken();
  if (!token) {
    return {
      ok: false,
      error: 'Please log in to view your rewards.',
      needsAuth: true,
    };
  }
  try {
    const raw = await sdk.client.fetch('/store/rewards', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });

    // Validate the outer envelope exists (schema is loose — won't throw on unknown fields)
    const envelope = parseOne(RewardsEnvelopeSchema, raw);

    const grants = parseList(
      RewardGrantSchema,
      (raw as { grants?: unknown }).grants,
    ).map((g) => ({
      id: g.id,
      kind: g.kind,
      status: g.status,
      payload:
        (g.payload as Record<string, unknown> | null | undefined) ?? null,
      grantedAt: g.granted_at,
    }));

    const rawDrawState = parseOne(
      RewardDrawStateSchema,
      (raw as { draw_state?: unknown }).draw_state,
    );
    const drawState: RewardDrawState | null = rawDrawState
      ? {
          drawsToday: rawDrawState.draws_today,
          drawsPerDay: rawDrawState.draws_per_day,
          poolEnabled: rawDrawState.pool_enabled,
          tier: rawDrawState.tier,
        }
      : null;

    const prizes = parseList(
      RewardPrizeSchema,
      (raw as { prizes?: unknown }).prizes,
    ).map((p) => ({
      pullId: p.pull_id,
      prizeKind: p.prize_kind,
      prizeSnapshot:
        (p.prize_snapshot as Record<string, unknown> | null | undefined) ??
        null,
      status: p.status,
      drawDay: p.draw_day,
    }));

    const redemptionEnabled = envelope?.redemption_enabled ?? false;

    return { ok: true, grants, drawState, prizes, redemptionEnabled };
  } catch (error) {
    logger.error('[rewards] load failed:', error);
    return {
      ok: false,
      error: friendlyError(error, REWARDS_RULES, REWARDS_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

/** Claim a voucher or frame grant. Only for kind='voucher'|'frame'. */
export async function claimReward(grantId: string): Promise<ClaimGrantResult> {
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
    logger.error(`[rewards] claim failed for '${grantId}':`, error);
    return {
      ok: false,
      error: friendlyError(error, REWARDS_RULES, REWARDS_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

/** Open today's daily box. Fail-closed: the backend 403s when the gate is off. */
export async function drawBox(): Promise<DrawBoxResult> {
  const token = await getAuthToken();
  if (!token) {
    return { ok: false, error: 'Please log in first.', needsAuth: true };
  }
  try {
    const parsed = parseOne(
      DrawBoxSchema,
      await sdk.client.fetch('/store/rewards/draw', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: {},
      }),
    );
    if (!parsed) {
      return {
        ok: false,
        error: 'Got an unexpected response. Please try again.',
      };
    }
    const prize: DrawPrize | undefined = parsed.prize
      ? {
          kind: parsed.prize.kind,
          title: parsed.prize.title,
          image: parsed.prize.image,
          amountMyr: parsed.prize.amount_myr,
          productHandle: parsed.prize.product_handle,
        }
      : undefined;
    return { ok: true, status: parsed.status, prize };
  } catch (error) {
    logger.error('[rewards] draw failed:', error);
    // 403 = gate off — show a friendly "not yet" message
    return {
      ok: false,
      error: friendlyError(error, REWARDS_RULES, REWARDS_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}

// WithdrawAddressSchema + WithdrawAddressInput live in @/lib/data/schemas (the
// app's sole `zod` importer — eslint no-restricted-imports forbids importing zod
// here). Re-exported so existing consumers (RewardsClient) keep their import path.
export type { WithdrawAddressInput };

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
    logger.error(`[rewards] withdraw failed for '${pullId}':`, error);
    return {
      ok: false,
      error: friendlyError(error, REWARDS_RULES, REWARDS_FALLBACK),
      needsAuth: isAuthError(error),
    };
  }
}
