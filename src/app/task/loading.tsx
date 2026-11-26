// /task reads cookies and awaits the hub before its first byte, and Next
// prefetches a dynamic route only down to its nearest loading boundary: with
// none, a tap on the Task tab did nothing visible until the server answered.
//
// Shaped like TaskHubClient on the Daily tab, the one it opens on: the title
// (real text, same place, not animated; lg up only, as on the page), the three
// section chips, the check-in card and four task rows. No PendingSpins block: it shows only when a
// free rip waits. A visitor gets the sign-in prompt instead of tickets; the
// title and the pill still land where the page puts them.
import { SkeletonExit } from '@/components/PageTransition';
import {
  BONE,
  PAGE_COLUMN,
  PAGE_FILL,
  PageTitle,
  SkeletonReveal,
} from '@/components/ui/page-frame';
import { cn } from '@/lib/utils';
import {
  REWARDS_SECTIONS,
  SectionSwitch,
} from '@/components/app-shell/SectionSwitch';

export default function TaskLoading() {
  return (
    <SkeletonExit>
      <div className={cn(PAGE_COLUMN, 'pt-4 lg:hidden')}>
        <SectionSwitch label="Rewards" items={REWARDS_SECTIONS} />
      </div>
      <div
        role="status"
        aria-live="polite"
        className={cn(PAGE_COLUMN, PAGE_FILL, 'pb-6 lg:pt-6')}
      >
        {/* The title shows from lg only, as on the page. */}
        <PageTitle as="p" className="hidden lg:block">
          TASK
        </PageTitle>
        <span className="sr-only">Loading</span>

        <SkeletonReveal>
          <div className={BONE.pulse}>
            {/* Daily / Weekly / Achievements: three 44px chips. */}
            <div className="mt-4 grid h-11 grid-cols-[1fr_1fr_1.45fr] gap-2 sm:grid-cols-3">
              {Array.from({ length: 3 }, (_, i) => (
                <div key={i} className={BONE.track} />
              ))}
            </div>

            {/* CheckInTrack: heading row, six 5:7 day slots and the larger day
                7, the next-line sentence and the 48px check-in pill. */}
            <div className="mt-4 rounded-3xl border border-white/10 bg-neutral-900 p-4 sm:p-5">
              <div className="flex h-7 items-center justify-between">
                <div className={cn(BONE.bar, 'h-5 w-28')} />
                <div className={cn(BONE.line, 'h-4 w-20')} />
              </div>
              <div className="mt-4 grid grid-cols-[repeat(6,minmax(0,1fr))_minmax(0,1.5fr)] items-end gap-1.5 sm:gap-2">
                {Array.from({ length: 7 }, (_, i) => (
                  <div
                    key={i}
                    className={cn(
                      'rounded-xl border border-white/10 bg-neutral-800',
                      i === 6 ? 'aspect-[6/7]' : 'aspect-[5/7]',
                    )}
                  />
                ))}
              </div>
              <div className="mt-4 flex h-5 items-center pr-[22%] sm:h-[22px]">
                <div className={cn(BONE.line, 'h-3 w-full')} />
              </div>
              <div className="mt-4 h-12 rounded-full bg-white/10" />
            </div>

            {/* Today's tasks: the list heading, then the rows. */}
            <div className="mt-4">
              <div className="flex h-6 items-center justify-between px-1">
                <div className={cn(BONE.bar, 'h-4 w-16')} />
                <div className={cn(BONE.line, 'h-3 w-24')} />
              </div>
              {/* A row's height follows its content (title, status line,
                  reward chips); 160px is a typical one. */}
              <div className="mt-3 space-y-2.5">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className={cn(BONE.panel, 'h-40 rounded-3xl')} />
                ))}
              </div>
            </div>
          </div>
        </SkeletonReveal>
      </div>
    </SkeletonExit>
  );
}
