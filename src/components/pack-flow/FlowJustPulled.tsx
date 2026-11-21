import PullsMarquee from '@/components/home/PullsMarquee';
import TheGame from '@/components/home/TheGame';
import type { LeaderboardEntry } from '@/lib/data/leaderboard';
import type { RecentFeed } from '@/lib/data/packs';
import { stackCards, startStack } from './drawer-model';
import { JustPulledShell } from './JustPulledShell';
import { JustPulledView } from './JustPulledView';

/** Without JavaScript the drawer is the plain list of every pull (as under
 *  reduced motion, drawer.module.css). Server-rendered only. */
const NO_SCRIPT_CSS = `
[data-jp-drawer]{height:auto!important}
[data-jp-drawer]>ol{position:static!important;display:grid!important;gap:10px}
[data-jp-card]{position:static!important;display:block!important;height:auto!important;transform:none!important;animation:none!important;pointer-events:auto!important}
[data-jp-art]{width:72px!important;height:100px!important}
[data-jp-empty]{position:static!important;height:auto!important;padding:40px 16px!important}
@media (min-width:1024px){[data-jp-drawer]>ol{grid-template-columns:1fr 1fr}}
`;

/**
 * The Just Pulled section of the preview (full-flow plan 1.1, work package
 * 11): one root with the section's data attribute, holding the drawer (the
 * heading with LIVE, the counters, the tier filter and the pulls), then the
 * live ticker and Top Collectors. The server renders the whole drawer at rest
 * from the page's feed; only a small shell is first-load code, and it swaps
 * in the live drawer's lazy chunk as the section nears. No scroll listeners,
 * no fixed elements; its height does not change when a pull arrives.
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
      <JustPulledShell initial={feed}>
        <JustPulledView
          cards={stackCards(startStack('', feed.pulls), Infinity)}
          stackKey=""
          drought={feed.drought}
          noun="pack"
          tab="All"
        />
      </JustPulledShell>
      <PullsMarquee pulls={feed.pulls} />
      <TheGame topRippers={topRippers} />
      <noscript>
        <style dangerouslySetInnerHTML={{ __html: NO_SCRIPT_CSS }} />
      </noscript>
    </div>
  );
}
