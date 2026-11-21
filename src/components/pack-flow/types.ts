/**
 * Types of the homepage flow's groundwork.
 * Types that already exist are imported; these are the ones that did not.
 *
 * The flow declares its own shapes here so it never imports pack-stage.
 */
import type { ResolvedPack } from '@/lib/packs-data';
import type { PackPullOdds, RecentFeed } from '@/lib/data/packs';
import type { PackTiers } from '@/lib/pack-tiers';
import type { PackBackDetails } from '@/components/pack-3d/pack-print';

/** The staff-entered pull odds, per tier in percent (`getPackHighlights`'s
 *  `pullOdds`; the existing parser's output, never derived). */
export type FlowPullOdds = PackPullOdds;

/** 'sleeve' for a card pack, 'capsule' for a ticket capsule (isTicketPack). */
export type FlowPackShape = 'sleeve' | 'capsule';

/**
 * The data one focused pack needs before anything is fetched.
 * - Pack page (cold load of `/slots/<id>`): `flowSeed(PackPageData)`, tiers and
 *   recent pulls included.
 * - Homepage: `flowSeedFromHighlights`, from the cached projection, so tiers
 *   and pulls are null until fetched at intent or focus.
 */
export type FlowSeed = {
  pack: ResolvedPack;
  shape: FlowPackShape;
  /** The tier view (lib/pack-tiers); null until fetched. */
  tiers: PackTiers | null;
  /** This pack's pull history; null = fetch on the client. */
  recentPulls: RecentFeed | null;
  /** The staff-entered odds the back prints; null = none entered. */
  pullOdds: FlowPullOdds | null;
  /** What the 3D back prints; null when the pack never turns (a capsule, or
   *  no pull odds: the no-odds rule). */
  back: PackBackDetails | null;
};

/** The live data the focused view renders (useFlowData). */
export type FlowData = {
  /** The pack, with the polled price / buyback / stock applied. */
  pack: ResolvedPack;
  tiers: PackTiers | null;
  recentPulls: RecentFeed;
  back: PackBackDetails | null;
  /** Changes exactly when the back's printed text changes (reprint trigger). */
  backKey: string;
};
