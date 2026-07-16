'use client';

import Image from 'next/image';
import Link from 'next/link';
import { cn } from '@/lib/utils';
import { useLiveRecentPulls } from '@/lib/use-recent-pulls';
import { PEDESTAL_BG, PEDESTAL_FRAME_HOVER } from '@/components/card-pedestal';
import { SlabImage } from '@/components/SlabImage';
import { rarityRgb } from '@/lib/rarity';
import type { RecentPull } from '@/lib/data/packs';

function PullCard({ pull }: { pull: RecentPull }) {
  return (
    <Link
      href="/slots"
      className={cn(
        'group/card block w-[240px] shrink-0 overflow-hidden rounded-2xl',
        'animate-[fadeIn_400ms_ease-out] motion-reduce:animate-none',
        'border bg-neutral-800',
        PEDESTAL_FRAME_HOVER,
      )}
      style={{ borderColor: `rgba(${rarityRgb(pull.rarity)}, 0.35)` }}
    >
      <div className="flex flex-col">
        {/* Slab on a dark pedestal / spotlight backdrop */}
        <div
          className={cn(
            'relative flex aspect-square w-full items-center justify-center overflow-hidden',
            PEDESTAL_BG,
          )}
        >
          {/* Xm ago badge, top-right */}
          <span className="absolute right-2 top-2 z-10 rounded-full border border-white/10 bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm">
            {pull.agoLabel}
          </span>
          {/* width chosen so the slab's height (w / 0.6 aspect) fills the
              square pedestal minus breathing room */}
          <SlabImage
            src={pull.image}
            slabSrc={pull.slabImage}
            alt={pull.name}
            sizes="128px"
            className="w-[124px] transition-transform duration-300 ease-out group-hover/card:scale-[1.04]"
          />
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-2 p-3">
          <p className="font-heading text-lg tabular-nums text-white">
            {pull.value}
          </p>
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
    </Link>
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
    <section className="mt-14 w-full bg-neutral-950">
      <div className="mx-auto w-full">
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

        {/* Horizontally-scrollable row of pulled-card cards. tabIndex makes it
            keyboard-focusable (arrow-scroll); the focus-visible ring gives keyboard
            users a clear indicator; aria-labelledby names it from the section
            heading instead of a duplicated literal. */}
        {pulls.length === 0 ? (
          <div className="px-fluid">
            <div className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-10 text-center text-[13px] text-white/60">
              No pulls yet — be the first to open a pack.
            </div>
          </div>
        ) : (
          <div
            role="group"
            aria-labelledby="recent-pulls-heading"
            tabIndex={0}
            className={cn(
              'px-fluid flex gap-4 overflow-x-auto pb-4',
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
