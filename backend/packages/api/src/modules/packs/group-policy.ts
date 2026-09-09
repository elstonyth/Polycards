import type { MedusaContainer } from '@medusajs/framework/types';
import { MedusaError } from '@medusajs/framework/utils';
import { isDefaultPlayerGroup, resolvePlayerGroup } from './odds-sets';

/**
 * Group policy — the "partner group" half of a player group (spec
 * docs/superpowers/specs/2026-09-09-partner-groups-design.md).
 *
 * Three keys on `customer_group.metadata`, beside `odds_set`:
 *   partner_rate_bp      non-null ⇒ this is a PARTNER group; members inherit
 *                        the rate (it beats customer_account_state.partner_referral_bp)
 *   withdrawals_blocked  members cannot start a bank withdrawal
 *   verification_exempt  members skip the phone-verification money/goods gates
 *
 * Metadata is admin-written, untyped JSON, so every reader is defensive the
 * way coerceOddsSet is: anything that is not exactly the expected shape is the
 * SAFE value (no rate, nothing blocked, nothing exempt).
 *
 * The admin app keeps a COPY of these key names (apps/admin/src/lib/
 * player-groups.ts) — its contract test reads this file, so rename here and
 * there together.
 */

export const PARTNER_RATE_KEY = 'partner_rate_bp';
export const WITHDRAWALS_BLOCKED_KEY = 'withdrawals_blocked';
export const VERIFICATION_EXEMPT_KEY = 'verification_exempt';

export type GroupPolicy = {
  partner_rate_bp: number | null;
  withdrawals_blocked: boolean;
  verification_exempt: boolean;
};

export const EMPTY_GROUP_POLICY: GroupPolicy = Object.freeze({
  partner_rate_bp: null,
  withdrawals_blocked: false,
  verification_exempt: false,
});

type GroupLike = {
  name?: string | null;
  metadata?: Record<string, unknown> | null;
};

/** A stored rate is a non-negative integer, as number or numeric string.
 *  Bounds against referral_settings are the WRITE path's job
 *  (editGroupPolicy); a read never invents a rate from a bad value. */
const coerceRateBp = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
};

/**
 * One group's policy. The DEFAULT group is pinned to the empty policy no
 * matter what its row stores — its members and customers with NO group must
 * behave identically (resolvePlayerGroup skips it, so this only matters for
 * readers handed the row directly, e.g. an admin list).
 */
export const groupPolicyOf = (g: GroupLike): GroupPolicy => {
  if (isDefaultPlayerGroup(g)) return EMPTY_GROUP_POLICY;
  const m = g.metadata ?? {};
  return {
    partner_rate_bp: coerceRateBp(m[PARTNER_RATE_KEY]),
    withdrawals_blocked: m[WITHDRAWALS_BLOCKED_KEY] === true,
    verification_exempt: m[VERIFICATION_EXEMPT_KEY] === true,
  };
};

export const isPartnerGroup = (g: GroupLike): boolean =>
  groupPolicyOf(g).partner_rate_bp !== null;

export type ResolvedGroupPolicy = {
  group: { id: string; name: string };
  policy: GroupPolicy;
};

/**
 * The policy a customer is actually under: their effective player group's
 * (oldest non-DEFAULT membership — the same group whose odds they roll), or
 * null when they have no real group.
 */
export async function resolveGroupPolicyForCustomer(
  container: MedusaContainer,
  customerId?: string,
): Promise<ResolvedGroupPolicy | null> {
  const group = await resolvePlayerGroup(container, customerId);
  if (!group) return null;
  return {
    group: { id: group.id, name: group.name },
    policy: groupPolicyOf(group),
  };
}

/** The message the admin shows next to the locked per-customer control and
 *  the one the route refuses with — one string, so the UI never promises a
 *  path the server then refuses differently. */
export const partnerGroupLockMessage = (groupName: string): string =>
  `This player is in partner group "${groupName}", whose rate applies to them. Move them out of the group to set a per-customer rate.`;

/**
 * Conflict rule (spec 2026-09-09): while a customer is in a partner group the
 * group's rate is what they earn, so a per-customer rate would be stored but
 * never paid. Refuse the write instead of accepting a lie.
 */
export async function assertNotInPartnerGroup(
  container: MedusaContainer,
  customerId: string,
): Promise<void> {
  const resolved = await resolveGroupPolicyForCustomer(container, customerId);
  if (resolved && resolved.policy.partner_rate_bp !== null) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      partnerGroupLockMessage(resolved.group.name),
    );
  }
}
