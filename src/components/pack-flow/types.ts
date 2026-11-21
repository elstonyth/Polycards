/**
 * Types of the homepage flow's groundwork.
 * Types that already exist are imported; these are the ones that did not.
 *
 * The stage's own contract (`src/components/pack-stage/contract.ts`, WP-D)
 * will carry `StageStop` / `StageScrollSource` / `StagePack.shape`; until it
 * does, the flow declares the same shapes here so it never imports pack-stage.
 * They are structurally identical, so the integration passes one for the other.
 */
import type { ResolvedPack } from '@/lib/packs-data';
import type { PackPullOdds, RecentFeed } from '@/lib/data/packs';
import type { PackLive, PackTiers } from '@/lib/pack-tiers';
import type { PackBackDetails } from '@/components/pack-3d/pack-print';

/** The staff-entered pull odds, per tier in percent (`getPackHighlights`'s
 *  `pullOdds`; the existing parser's output, never derived). */
export type FlowPullOdds = PackPullOdds;

/** 'sleeve' for a card pack, 'capsule' for a ticket capsule (isTicketPack). */
export type FlowPackShape = 'sleeve' | 'capsule';

/** The part of a stage pack `canTurn` reads (the contract's
 *  `StagePack.shape` once WP-D adds it). */
export type FlowShaped = { shape: FlowPackShape };

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
  shape: FlowPackShape;
  tiers: PackTiers | null;
  live: PackLive | null;
  recentPulls: RecentFeed;
  pullOdds: FlowPullOdds | null;
  back: PackBackDetails | null;
  /** Changes exactly when the back's printed text changes (reprint trigger). */
  backKey: string;
  /** canTurn(pack, back): false for a capsule or a pack without pull odds. */
  turns: boolean;
};

/** Where the address says the flow is (see flow-address). */
export type FlowLocation =
  { kind: 'stage' } | { kind: 'focus'; id: string } | { kind: 'other' };
