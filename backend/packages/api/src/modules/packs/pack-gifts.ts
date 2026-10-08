// Pack gifts (spec 2026-10-07 §3.1, §7) — the pure rules, DB-free so they are
// unit-testable. The service owns the writes (grant, revoke, claim, stamp).
import { FREE_WELCOME_CATEGORY } from './free-pack';

/** Most packs one grant may send. */
export const GIFT_MAX_QUANTITY = 10;
export const GIFT_NOTE_MAX = 512;

/** How long an open may hold a claimed gift without stamping its pull before
 *  the gift counts as unopened again (a crashed open whose rollback never
 *  ran). Far above any real open, which commits in well under a second. */
export const GIFT_CLAIM_LEASE_MINUTES = 10;

/** SQL predicate (table pack_gift, unaliased) for a gift that may be opened
 *  or revoked: not revoked, no pull yet, and never claimed — or its claim
 *  lapsed AND that open wrote no pull. The pulls and the stamp commit in
 *  separate workflow steps, so a crash between them leaves the open's pulls
 *  with the gift unstamped; reclaiming that gift would hand out a second
 *  card. Such a gift stays "stuck" for an operator instead. */
export const UNOPENED_GIFT_SQL =
  'revoked_at IS NULL AND deleted_at IS NULL AND pull_id IS NULL ' +
  'AND (opened_at IS NULL OR (' +
  `opened_at < now() - interval '${GIFT_CLAIM_LEASE_MINUTES} minutes' ` +
  'AND NOT EXISTS (SELECT 1 FROM pull p WHERE p.open_id = pack_gift.open_id AND p.deleted_at IS NULL)))';

export const STALE_GIFT_MESSAGE =
  'Your vault pack is no longer available — refresh.';

export type GiftState = 'unopened' | 'opened' | 'revoked' | 'stuck';

export function giftState(
  gift: {
    revoked_at: Date | string | null;
    pull_id: string | null;
    opened_at: Date | string | null;
  },
  now: Date = new Date(),
): GiftState {
  if (gift.revoked_at) return 'revoked';
  if (gift.pull_id) return 'opened';
  if (!gift.opened_at) return 'unopened';
  const claimedMs = new Date(gift.opened_at).getTime();
  // Claimed and inside the lease: an open is in flight right now.
  return now.getTime() - claimedMs >= GIFT_CLAIM_LEASE_MINUTES * 60_000
    ? 'stuck'
    : 'opened';
}

/** Why a pack cannot be gifted, or null. Free-welcome and reward-box packs
 *  are reserved categories with their own entitlement paths; a draft pack
 *  cannot be opened at all. */
export function giftablePackError(
  pack: { status?: string | null; category?: string | null } | undefined,
): string | null {
  if (!pack) return 'That pack does not exist.';
  if (pack.category === FREE_WELCOME_CATEGORY || pack.category === 'reward_box')
    return 'That pack cannot be gifted.';
  if (pack.status !== 'active') return 'Only an active pack can be gifted.';
  return null;
}

export function giftQuantityError(value: unknown): string | null {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > GIFT_MAX_QUANTITY
  )
    return `Quantity must be a whole number from 1 to ${GIFT_MAX_QUANTITY}.`;
  return null;
}

export function giftNoteError(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim() === '')
    return 'A note is required.';
  if (value.length > GIFT_NOTE_MAX)
    return `Note must be at most ${GIFT_NOTE_MAX} characters.`;
  return null;
}
