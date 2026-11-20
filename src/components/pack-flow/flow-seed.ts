/**
 * The focused view's starting data, built on the server (plan-step2 section 3,
 * "Data per section and surface"). Server-safe and pure: the callers hand in
 * what their page already read, nothing here fetches.
 *
 * - Cold load of `/slots/<id>` (the gated pack page): `flowSeed(PackPageData)`,
 *   with the tier view, the pull history and the back already in it.
 * - Homepage (`/`, cached and visitor-agnostic): `flowSeedFromHighlights`, from
 *   the pack and its `getPackHighlights` projection; the tier view and the
 *   pull history are fetched on the client at intent or focus.
 *
 * Odds come only from the staff-entered field: `detail.publishedOdds` (today's
 * name of the existing parser's output) on the pack page, `highlights.pullOdds`
 * on the homepage. Never derived.
 */
import type { PackPageData } from '@/lib/data/pack-page';
import type { PackHighlights } from '@/lib/data/packs';
import type { ResolvedPack } from '@/lib/packs-data';
import { packTiersOf } from '@/lib/pack-tiers';
import { backFor, shapeOf } from './flow-back';
import type { FlowPullOdds, FlowSeed } from './types';

/** The pack page's seed. */
export function flowSeed(data: PackPageData): FlowSeed {
  const entered = data.detail?.publishedOdds ?? null;
  const pullOdds: FlowPullOdds | null = entered
    ? { tiers: { ...entered.tiers } }
    : null;
  return {
    pack: data.pack,
    shape: shapeOf(data.pack),
    tiers: packTiersOf(data.pack, data.detail),
    recentPulls: data.recentPulls,
    pullOdds,
    back: backFor(data.pack, pullOdds),
  };
}

/** The homepage's seed for one pack: no tiers or pulls yet. */
export function flowSeedFromHighlights(
  pack: ResolvedPack,
  highlights: Pick<PackHighlights, 'pullOdds'> | null,
): FlowSeed {
  const pullOdds = highlights?.pullOdds ?? null;
  return {
    pack,
    shape: shapeOf(pack),
    tiers: null,
    recentPulls: null,
    pullOdds,
    back: backFor(pack, pullOdds),
  };
}
