'use client';

import Image from 'next/image';
import { cn } from '@/lib/utils';
import { useLiveRecentPulls } from '@/lib/use-recent-pulls';
import {
  PEDESTAL_BG,
  PEDESTAL_FRAME_HOVER,
  PEDESTAL_IMAGE,
} from '@/components/card-pedestal';
import type { RecentPull } from '@/lib/data/packs';

function PullCard({ pull }: { pull: RecentPull }) {
  return (
    <div
      className={cn(
        'group/card w-[240px] shrink-0 overflow-hidden rounded-2xl',
        'border border-neutral-700 bg-neutral-800',
        PEDESTAL_FRAME_HOVER,
        'hover:border-neutral-500',
      )}
    >
      <div className="flex flex-col">
        {/* Card image on a dark pedestal / spotlight backdrop */}
        <div
          className={cn(
            'relative aspect-square w-full overflow-hidden',
            PEDESTAL_BG,
          )}
        >
          {/* Xm ago badge, top-right */}
          <span className="absolute right-2 top-2 z-10 rounded-full border border-white/10 bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm">
            {pull.agoLabel}
          </span>
          <Image
            src={pull.image}
            alt={pull.name}
            fill
            sizes="(max-width: 640px) 60vw, (max-width: 1024px) 30vw, 238px"
            className={cn(PEDESTAL_IMAGE, 'p-4')}
          />
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-2 p-3">
          <p className="line-clamp-2 min-h-[40px] text-sm font-bold leading-5 text-white">
            {pull.name}
          </p>
          <div className="flex items-center gap-2">
            <Image
              src={pull.packIcon}
              alt={pull.packName}
              width={28}
              height={28}
              className="h-7 w-7 shrink-0 object-contain"
            />
            <div className="flex flex-col leading-tight">
              <span className="text-xs font-medium text-white">
                {pull.packName}
              </span>
              <span className="text-[10px] font-medium text-neutral-400">
                Pulled by {pull.who}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function RecentPullsSection({
  initialPulls,
}: {
  /** Live recent pulls (server-fetched); empty = no pulls yet (empty state). */
  initialPulls?: RecentPull[];
}) {
  // Live feed — shared 4s polling hook (same seam as the pack-detail feed).
  const pulls = useLiveRecentPulls(initialPulls ?? []);

  return (
    <section className="w-full bg-neutral-950 py-16 sm:py-20">
      <div className="mx-auto w-full">
        {/* Header */}
        <div className="mx-auto mb-10 flex max-w-2xl flex-col items-center text-center">
          <p className="text-[11px] font-medium uppercase tracking-[0.3em] text-white/50">
            Live from the claw
          </p>
          <h2
            id="recent-pulls-heading"
            className="font-heading mt-1.5 bg-gradient-to-b from-white to-neutral-400 bg-clip-text text-2xl font-bold leading-tight tracking-tight text-transparent md:text-3xl"
          >
            Recent Pulls
          </h2>
          <p className="mt-1.5 text-sm text-neutral-400">
            See what collectors are pulling right now.
          </p>
        </div>

        {/* Horizontally-scrollable row of pulled-card cards. tabIndex makes it
            keyboard-focusable (arrow-scroll); the focus-visible ring gives keyboard
            users a clear indicator; aria-labelledby names it from the section
            heading instead of a duplicated literal. */}
        {pulls.length === 0 ? (
          <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-10 text-center text-[13px] text-white/40">
            No pulls yet — be the first to open a pack.
          </div>
        ) : (
          <div
            role="group"
            aria-labelledby="recent-pulls-heading"
            tabIndex={0}
            className={cn(
              'flex gap-4 overflow-x-auto pb-4',
              '[scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden',
              'snap-x snap-mandatory scroll-px-4',
              'focus-visible:rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950',
            )}
          >
            {pulls.map((pull) => (
              <div key={pull.id} className="snap-start">
                <PullCard pull={pull} />
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
