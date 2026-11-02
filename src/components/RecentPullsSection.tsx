'use client';

import { PullHistory } from '@/components/PullHistory';
import { useShelfCategory } from '@/components/home/ShelfCategory';
import type { RecentFeed } from '@/lib/data/packs';
import { POLY_CATEGORY } from '@/lib/packs-data';

/** Home board 03 — live proof: the pull history (drought counters, tier tabs,
 *  the row feed), global unless the shelf above is on Poly, which reads its
 *  capsules' spins. The panel itself is PullHistory; this is the board lockup
 *  around it. */
export default function RecentPullsSection({
  initial,
}: {
  /** Live pull history (server-fetched, global); an empty feed renders the empty
   *  state. shortcut: a Poly default tab (no Pokémon pack live) shows this seed
   *  until the first poll, 10s. Fetch the Poly seed if Poly ever leads. */
  initial: RecentFeed;
}) {
  const poly = useShelfCategory().active === POLY_CATEGORY;
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
        <PullHistory
          initial={initial}
          category={poly ? POLY_CATEGORY : undefined}
          noun={poly ? 'capsule' : 'pack'}
        />
      </div>
    </section>
  );
}
