import PullsMarquee from '@/components/home/PullsMarquee';
import TheGame from '@/components/home/TheGame';
import RecentPullsSection from '@/components/RecentPullsSection';
import type { LeaderboardEntry } from '@/lib/data/leaderboard';
import type { RecentFeed } from '@/lib/data/packs';

/**
 * The Just Pulled section of the preview (full-flow plan 1.1): one root with
 * the section's data attribute. Until its redesign it holds today's three
 * pieces unchanged, in this order: the live ticker, Just Pulled, Top
 * Collectors. No listeners, no fixed elements; any height.
 */
export function FlowJustPulled({
  feed,
  topRippers,
}: {
  feed: RecentFeed;
  topRippers: LeaderboardEntry[];
}) {
  return (
    <div data-flow-section="just-pulled">
      <PullsMarquee pulls={feed.pulls} />
      <RecentPullsSection initial={feed} />
      <TheGame topRippers={topRippers} />
    </div>
  );
}
