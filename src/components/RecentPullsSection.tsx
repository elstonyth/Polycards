import { PullHistory } from '@/components/PullHistory';
import type { RecentFeed } from '@/lib/data/packs';

/** Home board 03 — live proof: the global pull history (drought counters,
 *  tier tabs, the row feed). The panel itself is PullHistory; this is the
 *  board lockup around it. */
export default function RecentPullsSection({
  initial,
}: {
  /** Live pull history (server-fetched); an empty feed renders the empty state. */
  initial: RecentFeed;
}) {
  return (
    <section
      aria-labelledby="recent-pulls-heading"
      className="mt-14 w-full bg-neutral-950"
    >
      {/* Header — drop-board lockup */}
      <div className="px-fluid mb-6 flex items-baseline gap-3">
        <h2
          id="recent-pulls-heading"
          className="font-heading text-2xl text-white"
        >
          JUST PULLED
        </h2>
        <span className="flex items-center gap-1.5 rounded-full bg-neutral-800 px-2.5 py-1 text-[11px] font-semibold text-white">
          {/* White dot — LIVE is not a money signal, so no green (Signal Rule) */}
          <span
            className="h-1.5 w-1.5 animate-pulse rounded-full bg-white motion-reduce:animate-none"
            aria-hidden
          />
          LIVE
        </span>
      </div>

      <div className="px-fluid">
        <PullHistory initial={initial} />
      </div>
    </section>
  );
}
