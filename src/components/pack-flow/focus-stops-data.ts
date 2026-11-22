/**
 * The focused pack view's pure helpers (FocusStops): which block shows at a
 * focus value, the Top Hits row, and where the Recent Pulls list ends.
 */
import { type PackCard } from '@/lib/packs-data';
import { ticketTopHits } from '@/lib/packs-format';
import type { FlowData } from './types';

/** The block shown at focus F: switches 20% into a move, either way (`falling`: F is moving up the stops). */
export const blockOf = (f: number, n: number, falling = false) =>
  Math.min(n, Math.max(0, falling ? Math.ceil(f - 0.8) : Math.floor(f + 0.8)));

/**
 * The first row of a list that its box would cut (rows' bottoms from the
 * box's top, in order): the list shows the rows before it, whole.
 */
export function firstCutRow(bottoms: readonly number[], height: number) {
  const i = bottoms.findIndex((b) => b > height);
  return i < 0 ? bottoms.length : i;
}

/** Top Hits: the top tiers' cards in one row, most valuable first (the pack page's order). */
export function topHitsOf(data: Pick<FlowData, 'tiers'>, tickets: boolean) {
  const cards = (data.tiers?.tiers ?? []).flatMap(
    (t) => t.cards ?? [],
  ) as unknown as PackCard[];
  if (tickets) return ticketTopHits(cards);
  return cards
    .map((c, i) => ({ c, i }))
    .sort((a, b) => {
      const pa = a.c.priceMyr ?? null;
      const pb = b.c.priceMyr ?? null;
      if (pa === pb) return a.i - b.i;
      if (pa === null) return 1;
      if (pb === null) return -1;
      return pb - pa || a.i - b.i;
    })
    .map((x) => x.c);
}
