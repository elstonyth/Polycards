// /leaderboard is force-dynamic and awaits five reads before its first byte,
// and Next prefetches a dynamic route only down to its nearest loading
// boundary: with none, a tap on the Ranks tab did nothing visible for over a
// second.
//
// Shaped like the page with the Weekly Challenge on: the RANKS title (real
// text, same place, not animated), the challenge hero (emblem, the heading,
// the reset line) and the community pool panel, then the standings head
// (LEADERBOARD, the period pill, the note) and six rows. Sizes measured on a
// production build (2026-11-19): the heading is two 40px lines below md and
// one from md (three at 320px), the pool panel 186px on a phone and 214px
// from sm, so the pool lands where the page puts it from 375px up.
import { SkeletonExit } from '@/components/PageTransition';
import {
  BONE,
  PAGE_COLUMN,
  PageTitle,
  SkeletonReveal,
} from '@/components/ui/page-frame';
import { cn } from '@/lib/utils';

export default function LeaderboardLoading() {
  return (
    <SkeletonExit>
      <div role="status" aria-live="polite">
        <header className={cn(PAGE_COLUMN, 'pt-6')}>
          <PageTitle as="p">RANKS</PageTitle>
        </header>
        <span className="sr-only">Loading</span>

        <SkeletonReveal className={cn(PAGE_COLUMN, 'pt-4')}>
          <div className={BONE.pulse}>
            {/* Challenge hero: 112px emblem, text-4xl heading (40px lines),
                the reset line. */}
            <div className="mx-auto h-28 w-28 rounded-3xl bg-white/[0.06]" />
            <div className="mt-4 flex flex-col items-center">
              <div className="flex h-10 w-full items-center justify-center">
                <div className={cn(BONE.bar, 'h-8 w-[85%]')} />
              </div>
              <div className="flex h-10 w-full items-center justify-center md:hidden">
                <div className={cn(BONE.bar, 'h-8 w-3/5')} />
              </div>
            </div>
            <div className="mt-3 flex h-4 items-center justify-center">
              <div className={cn(BONE.line, 'h-3 w-44')} />
            </div>

            {/* Community pool: p-6, label, readout, checkpoint bar, the sm+
                label row, next-stage line. */}
            <div className="mt-8 h-[186px] rounded-2xl border border-white/10 bg-neutral-900 sm:h-[214px]" />

            {/* Standings head: LEADERBOARD (text-3xl, 36px line) at pt-6. */}
            <div className="pt-6">
              <div className="flex h-9 items-center">
                <div className={cn(BONE.bar, 'h-7 w-48')} />
              </div>
            </div>
            <div className={cn(BONE.track, 'mt-4 h-[54px]')} />
            <div className="mt-3 flex h-[18px] items-center">
              <div className={cn(BONE.line, 'h-3 w-full')} />
            </div>

            {/* LIVE STANDINGS, the column header, six rows */}
            <div className="mt-6 flex h-7 items-center">
              <div className={cn(BONE.bar, 'h-5 w-36')} />
            </div>
            <div className="mt-3 h-4" />
            <div className="mt-2 overflow-hidden rounded-2xl border border-white/10 bg-neutral-900">
              {Array.from({ length: 6 }, (_, i) => (
                <div
                  key={i}
                  className={cn(
                    'flex items-center gap-3 px-4 py-3',
                    i > 0 && 'border-t border-white/5',
                  )}
                >
                  <div className="h-6 w-8 shrink-0" />
                  <div className="h-9 w-9 shrink-0 rounded-full bg-white/10" />
                  <div className="flex h-[54px] min-w-0 flex-1 flex-col justify-center gap-2">
                    <div className={cn(BONE.bar, 'h-3.5 w-32 max-w-full')} />
                    <div className={cn(BONE.line, 'h-3 w-24 max-w-full')} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </SkeletonReveal>
      </div>
    </SkeletonExit>
  );
}
