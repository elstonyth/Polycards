/**
 * The focused pack's back: what it prints, when it reprints, and whether the
 * pack turns to it at all (plan-step2 sections 1, 3 and 4). Pure and
 * server-safe.
 *
 * Rules, in the owner's order:
 * - Capsules never turn ("Small leans only", 2026-11-20). Checked FIRST:
 *   capsules carry pull odds, so the odds test alone would let them turn.
 * - No-odds rule (2026-11-20): a pack with no pull odds never turns and never
 *   prints a back. No empty odds box, no invented numbers, no fallback.
 * - Odds source rule: the odds printed are the staff-entered ones only
 *   (`pullOdds`), passed in by the caller from `getPackHighlights` or the
 *   tier view; nothing here derives a chance.
 */
import { isTicketPack, type Pack, type ResolvedPack } from '@/lib/packs-data';
import type { PackLive } from '@/lib/pack-tiers';
import { packBackDetails } from '@/components/pack-3d/pack-back-details';
import type { PackBackDetails } from '@/components/pack-3d/pack-print';
import type { FlowPackShape, FlowPullOdds, FlowShaped } from './types';

/** 'capsule' for a ticket capsule, 'sleeve' for a card pack. */
export const shapeOf = (pack: Pick<Pack, 'prizeType'>): FlowPackShape =>
  isTicketPack(pack) ? 'capsule' : 'sleeve';

/** True when at least one tier has a staff-entered chance. */
const hasPullOdds = (odds: FlowPullOdds | null | undefined): boolean =>
  !!odds && Object.values(odds.tiers).some((v) => typeof v === 'number');

/** The pack with the polled live figures applied (price, buyback, stock). */
export function withLive(
  pack: ResolvedPack,
  live: PackLive | null,
): ResolvedPack {
  if (!live) return pack;
  return {
    ...pack,
    priceMyr: live.priceMyr,
    // A capsule's live buyback is null (it has none): keep the pack's own.
    buybackPercent: live.buybackPercent ?? pack.buybackPercent,
    inStock: live.inStock ? undefined : false,
  };
}

/**
 * What the pack's back prints, through the page's own formatters
 * (`packBackDetails`), or null when it must never print one: a capsule (it has
 * no back), or no pull odds (no-odds rule).
 */
export function backFor(
  pack: ResolvedPack,
  pullOdds: FlowPullOdds | null | undefined,
  live: PackLive | null = null,
): PackBackDetails | null {
  if (shapeOf(pack) === 'capsule') return null;
  if (!hasPullOdds(pullOdds)) return null;
  const back = packBackDetails(withLive(pack, live), pullOdds);
  // packBackDetails prints `odds: null` for odds with no tier rows: that is
  // the empty box the no-odds rule forbids.
  return back.odds === null ? null : back;
}

/** Changes exactly when the printed text changes (price, buyback, odds), so
 *  the stage reprints only then (section 4: debounced, never mid-turn). */
export const backKey = (back: PackBackDetails | null): string =>
  back === null
    ? 'none'
    : JSON.stringify([
        back.price,
        back.productLine,
        back.odds,
        back.buyback?.headline ?? null,
        back.buyback?.rule ?? null,
      ]);

/**
 * Whether the focused pack turns to its back (the stage's one switch): never
 * for a capsule (checked first), otherwise only with a printable back.
 */
export function canTurn(
  pack: FlowShaped,
  details: PackBackDetails | null,
): boolean {
  if (pack.shape === 'capsule') return false;
  return details !== null && details.odds !== null;
}
