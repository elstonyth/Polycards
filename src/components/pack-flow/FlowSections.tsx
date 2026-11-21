import type { LeaderboardEntry } from '@/lib/data/leaderboard';
import type { RecentFeed } from '@/lib/data/packs';
import { FlowJustPulled } from './FlowJustPulled';
import { FlowSpacers } from './FlowSpacers';
import { FlowTelegram } from './FlowTelegram';

/**
 * Everything below the stage on the preview, in the flow's order: the paged
 * spacers, then Just Pulled straight after the lineup (it rises in as the
 * packs lift away), Telegram with the trust points and the footer, then the
 * Return and Last spacers. Server-rendered: no client code of its own.
 *
 * `freePackPromo` and `showOffer` are still passed by the page and are not
 * read here.
 */
export function FlowSections({
  feed,
  topRippers,
}: {
  feed: RecentFeed;
  topRippers: LeaderboardEntry[];
  /** A free welcome pack is on offer to a new visitor (getFreePackPromo). */
  freePackPromo: boolean;
  /** The stage has packs. */
  showOffer: boolean;
}) {
  return (
    <>
      <FlowSpacers part="paged" />
      <FlowJustPulled feed={feed} topRippers={topRippers} />
      <FlowTelegram />
      <FlowSpacers part="end" />
    </>
  );
}
