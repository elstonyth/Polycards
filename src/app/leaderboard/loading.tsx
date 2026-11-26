// /leaderboard is force-dynamic and awaits five reads before its first byte,
// and Next prefetches a dynamic route only down to its nearest loading
// boundary: with none, a tap on the Ranks tab did nothing visible for over a
// second.
//
// Shaped like the page with the Weekly Challenge on (redesign v3): the RANKS
// title (real text, same place, not animated; lg up only, as on the page),
// the challenge title and reset chip, the period pill and its note, the
// podium, the community goal panel on the podium's blocks, three more rows,
// then the weekly reward stages. The podium bones use the page's own sizes
// (crown, ringed avatars, name, value, pulls, prize slot, stepped blocks), so
// the goal panel lands where the page puts it. The stage card keeps the
// measured rail height (492.5px, 500.5px from sm). The data-bone attributes
// are hooks for the tab-flow measuring script.
import { SkeletonExit } from '@/components/PageTransition';
import {
  BONE,
  PAGE_COLUMN,
  PageTitle,
  SkeletonReveal,
} from '@/components/ui/page-frame';
import { cn } from '@/lib/utils';
import {
  REWARDS_SECTIONS,
  SectionSwitch,
} from '@/components/app-shell/SectionSwitch';

// Rank 2, 1, 3 left to right, as the podium lays them out.
const PODIUM = [
  { avatar: 'h-14 w-14', block: 'h-14', crown: false },
  { avatar: 'h-[72px] w-[72px]', block: 'h-20', crown: true },
  { avatar: 'h-14 w-14', block: 'h-10', crown: false },
] as const;

export default function LeaderboardLoading() {
  return (
    <SkeletonExit>
      <div className={cn(PAGE_COLUMN, 'pt-4 lg:hidden')}>
        <SectionSwitch label="Rewards" items={REWARDS_SECTIONS} />
      </div>
      <div role="status" aria-live="polite">
        <header className={cn(PAGE_COLUMN, 'lg:pt-6')}>
          <PageTitle as="p" className="hidden lg:block">
            RANKS
          </PageTitle>
        </header>
        <span className="sr-only">Loading</span>

        <SkeletonReveal className={cn(PAGE_COLUMN, 'pt-4')}>
          <div className={BONE.pulse}>
            {/* Challenge title (text-xl, sm:text-2xl) and the reset chip; the
                chip wraps under the title on a phone, as on the page. */}
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
              <div className="flex h-7 items-center sm:h-8">
                <div className={cn(BONE.bar, 'h-5 w-48')} />
              </div>
              <div className="h-[30px] w-[205px] rounded-full border border-white/10 bg-neutral-800" />
            </div>

            {/* Period pill (44px buttons + p-1 + border) and its note, which
                runs to three lines on a phone. */}
            <div className={cn(BONE.track, 'mt-4 h-[54px]')} />
            <div className="mt-3 flex h-[54px] flex-col justify-center gap-2 sm:h-9 lg:h-[18px]">
              <div className={cn(BONE.line, 'h-3 w-full')} />
            </div>

            {/* Podium: crown, ringed avatar, name (44px tap row), value,
                pulls, the prize slot, the stepped block. */}
            <div
              data-bone="podium"
              className="mt-6 grid grid-cols-3 items-end gap-2"
            >
              {PODIUM.map((p, i) => (
                <div key={i} className="flex flex-col items-center">
                  {p.crown && (
                    <div className="-mb-5 h-16 w-16 sm:h-20 sm:w-20" />
                  )}
                  <div className="rounded-full p-1 ring-2 ring-white/10">
                    <div className={cn('rounded-full bg-white/10', p.avatar)} />
                  </div>
                  <div className="-mb-2 flex h-11 items-start pt-2.5">
                    <div className={cn(BONE.bar, 'h-3.5 w-16')} />
                  </div>
                  <div className="flex h-5 items-center sm:h-6">
                    <div className={cn(BONE.line, 'h-3 w-14')} />
                  </div>
                  <div className="h-[16.5px]" />
                  <div className="mt-1.5 h-10" />
                  <div
                    className={cn(
                      'mt-2 w-full rounded-t-2xl border border-b-0 border-white/10 bg-neutral-900',
                      p.block,
                    )}
                  />
                </div>
              ))}
            </div>

            {/* Community goal: label, readout, staged bar, the sm+ label row
                and the next-stage line (two lines below 430px). */}
            <div
              data-bone="goal"
              className="h-[174px] rounded-3xl border border-white/10 bg-neutral-900 min-[430px]:h-[158px] sm:h-[186px]"
            />

            {/* The column header and three more ranks. */}
            <div className="mt-4 h-4" />
            <div className="mt-2 overflow-hidden rounded-3xl border border-white/10 bg-neutral-900">
              {Array.from({ length: 3 }, (_, i) => (
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

            {/* Weekly reward stages: the heading, the stage pills (flex-wrap,
                so four of them wrap onto two rows on a narrow phone as the
                real ones do), the stage card at the rail's height and width,
                and the "n of N" line under it. */}
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
                  'h-full w-[var(--slab-w)] max-w-full rounded-3xl',
                )}
              />
            </div>
            <div
              data-bone="stage-counter"
              className="mt-3 flex h-[18px] items-center justify-center"
            >
              <div className={cn(BONE.line, 'h-3 w-12')} />
            </div>
          </div>
        </SkeletonReveal>
      </div>
    </SkeletonExit>
  );
}
