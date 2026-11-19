// /leaderboard is force-dynamic and awaits five reads before its first byte,
// and Next prefetches a dynamic route only down to its nearest loading
// boundary: with none, a tap on the Ranks tab did nothing visible for over a
// second.
//
// Shaped like the page with the Weekly Challenge on: the RANKS title (real
// text, same place, not animated), the challenge hero (emblem, the heading,
// the reset line), the community pool panel and the weekly reward stages,
// then the standings head (LEADERBOARD, the period pill, the note) and six
// rows. Sizes measured on a
// production build (2026-11-19/20): the heading is two 40px lines below md and
// one from md (three at 320px), the pool panel 186-218px on a phone and 214px
// from sm, the stage rail 492.5px (500.5px from sm, p-5 cards), so the pool
// and the stages block land where the page puts them from 375px up. The
// data-bone attributes are hooks for the tab-flow measuring script.
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
                label row, next-stage line. On a phone two of its lines wrap:
                the label below ~385px, and the next-stage line ("Stage N
                unlocks at RM 7,000,000 — RM 3,114,163 to go") below 430px
                while both figures run to seven digits (+16px each). */}
            <div className="mt-8 h-[202px] rounded-2xl border border-white/10 bg-neutral-900 max-[384px]:h-[218px] min-[430px]:h-[186px] sm:h-[214px]" />

            {/* Weekly reward stages: the h3, the stage pills (flex-wrap, so
                four of them wrap onto two rows on a narrow phone as the real
                ones do), the stage card at the rail's height and width, and
                the "n of N" line under it. */}
            <div
              data-bone="stages-heading"
              className="mt-8 flex h-7 items-center"
            >
              <div className={cn(BONE.bar, 'h-5 w-52')} />
            </div>
            <div
              data-bone="stage-pills"
              className="mt-2 mb-3 flex flex-wrap items-center justify-center gap-2"
            >
              {/* Three passed stages carry an icon; the selected one does not. */}
              {['w-[89px]', 'w-[89px]', 'w-[89px]', 'w-[71px]'].map((w, i) => (
                <div
                  key={i}
                  className={cn('h-11 rounded-full bg-neutral-900', w)}
                />
              ))}
            </div>
            <div
              data-bone="stage-card"
              className="flex h-[492.5px] justify-center [--slab-w:min(82vw,360px)] sm:h-[500.5px]"
            >
              <div
                className={cn(
                  BONE.panel,
                  'h-full w-[var(--slab-w)] max-w-full',
                )}
              />
            </div>
            <div
              data-bone="stage-counter"
              className="mt-3 flex h-[18px] items-center justify-center"
            >
              <div className={cn(BONE.line, 'h-3 w-12')} />
            </div>

            {/* Standings head: LEADERBOARD (text-3xl, 36px line) at pt-6.
                The rewards summary between the stages and here is left out:
                its height follows the week's unlocked prizes (about 100px to
                700px), so the standings start higher than on the page. */}
            <div className="pt-6">
              <div data-bone="standings-head" className="flex h-9 items-center">
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
