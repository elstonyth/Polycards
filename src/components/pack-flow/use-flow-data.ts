'use client';

import { useMemo } from 'react';
import { usePackLive } from '@/app/slots/[slug]/use-pack-live';
import type { RecentFeed } from '@/lib/data/packs';
import { pullOddsOf, type PackTiers } from '@/lib/pack-tiers';
import { backFor, backKey, withLive } from './flow-back';
import type { FlowData, FlowPullOdds, FlowSeed } from './types';

const EMPTY_FEED: RecentFeed = { pulls: [], drought: {} };

/** The pull odds a fetched tier view carries (the same staff-entered field,
 *  handed on per tier by /api/pack-tiers); null when no tier has a chance. */
function pullOddsFromTiers(tiers: PackTiers | null): FlowPullOdds | null {
  if (!tiers) return null;
  const odds = pullOddsOf(tiers.tiers);
  return Object.keys(odds).length > 0 ? { tiers: odds } : null;
}

/**
 * The focused pack's live data.
 *
 * Seeded from the server (`flowSeed` on the pack page, `flowSeedFromHighlights`
 * on the homepage), then filled from `/api/pack-tiers/<slug>` through the pack
 * page's own `usePackLive`: fetched at once when the seed has no tiers (the
 * homepage), five seconds after a seeded load otherwise, then every 60 s.
 *
 * `enabled` is the homepage's intent-or-focus switch: false fetches nothing
 * (a carousel with no intent yet); true starts the poll. The pack page passes
 * true from the start.
 *
 * Odds: the back prints the staff-entered odds only. Before the tier view
 * lands that is the seed's `pullOdds` (from `getPackHighlights` or the pack
 * page's detail); after, the same field as the tier view hands it on. A pack
 * with none prints no back and never turns (no-odds rule).
 */
export function useFlowData(
  seed: FlowSeed,
  { enabled = true }: { enabled?: boolean } = {},
): FlowData {
  const { tiers, live } = usePackLive(
    enabled ? seed.pack.id : null,
    seed.tiers,
  );
  return useMemo(() => {
    const pack = withLive(seed.pack, live);
    const pullOdds = tiers ? pullOddsFromTiers(tiers) : seed.pullOdds;
    const back = backFor(seed.pack, pullOdds, live);
    return {
      pack,
      tiers,
      recentPulls: seed.recentPulls ?? EMPTY_FEED,
      back,
      backKey: backKey(back),
    };
  }, [seed, tiers, live]);
}
