/**
 * The focused view's starting data, built on the server. Server-safe and pure:
 * the caller hands in what its page already read, nothing here fetches.
 *
 * The homepage seeds each pack from the pack and its `getPackHighlights`
 * projection; the tier view and the pull history are fetched on the client at
 * intent or focus.
 *
 * Odds come only from the staff-entered field (`highlights.pullOdds`). Never
 * derived.
 */
import type { PackHighlights } from '@/lib/data/packs';
import type { ResolvedPack } from '@/lib/packs-data';
import { backFor, shapeOf } from './flow-back';
import type { FlowSeed } from './types';

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
