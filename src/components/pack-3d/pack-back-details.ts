// What a pack's 3D back prints (pack-print.ts), from the data the pack page
// already has and through the page's own formatters, so the back can never
// state anything the page does not:
//
//   price        rm(pack.priceMyr)                  the page's price ("RM 40.00")
//   productLine  pack.name + packFacts(pack) values the page header's facts
//   odds         pullOddsRows(pullOdds)             the Pull Odds board's rows
//   buyback      the header badge (PackDetailClient) and the explainer under it (PackBuyControls)
//
// No fetch here: the caller passes what it already holds (the homepage's
// pack projection, getPackHighlights, carries `pullOdds`). A caller with no
// odds passes `pullOdds: null | undefined` and the back prints no odds.
import { rm } from '@/lib/format';
import {
  FLAT_BUYBACK_PERCENT,
  FREE_WELCOME_CATEGORY,
  isTicketPack,
  packFacts,
  type ResolvedPack,
} from '@/lib/packs-data';
import { pullOddsRows, type PullOdds } from '@/lib/packs-format';
import type { PackBackDetails } from './pack-print';

/** The pack page's explainer under the buyback badge, word for word
 *  (the buy panel in PackBuyControls.tsx, "The pack rate applies during the
 *  reveal countdown…"). It names the FLAT vault rate, which a Lossless window
 *  never changes. pack-print.test.ts fails if the page's sentence drifts. */
export const BUYBACK_RULE = `The pack rate applies during the reveal countdown. Leaving the reveal or letting the timer expire changes buyback to ${FLAT_BUYBACK_PERCENT}% of card value in your vault.`;

/** The header badge's wording: the pack's INSTANT rate, which the backend
 *  lifts to 100 inside a Lossless window (withLossless on /store/packs). */
export const buybackHeadline = (
  pack: Pick<ResolvedPack, 'buybackPercent'>,
): string => `${pack.buybackPercent ?? FLAT_BUYBACK_PERCENT}% instant buyback`;

export function packBackDetails(
  pack: ResolvedPack,
  pullOdds: PullOdds | null | undefined,
): PackBackDetails {
  const isFree = pack.categoryId === FREE_WELCOME_CATEGORY;
  const ticket = isTicketPack(pack);
  const rows = pullOdds ? pullOddsRows(pullOdds) : [];
  return {
    // The free pack's page shows no price at all.
    price: isFree ? null : rm(pack.priceMyr),
    productLine: [pack.name, ...packFacts(pack).map((f) => f.value)],
    odds:
      rows.length > 0
        ? rows.map((r) => ({ label: r.rarity, chance: r.chance }))
        : null,
    // The page shows neither the badge nor the explainer on a free or a ticket pack.
    buyback:
      isFree || ticket
        ? null
        : { headline: buybackHeadline(pack), rule: BUYBACK_RULE },
  };
}
