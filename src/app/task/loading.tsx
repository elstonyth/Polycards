// /task reads cookies and awaits the hub before its first byte, and Next
// prefetches a dynamic route only down to its nearest loading boundary: with
// none, a tap on the Task tab did nothing visible until the server answered.
//
// Shaped like TaskHubClient on the Daily tab, the one it opens on: the title
// (real text, same place, not animated), the three-way section pill, the
// check-in track and four tickets. No PendingSpins block: it shows only when a
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

export default function TaskLoading() {
  return (
    <SkeletonExit>
      <div
        role="status"
        aria-live="polite"
        className={cn(PAGE_COLUMN, PAGE_FILL, 'pt-6 pb-6')}
      >
        <PageTitle as="p">TASK</PageTitle>
        <span className="sr-only">Loading</span>

        <SkeletonReveal>
          <div className={BONE.pulse}>
            {/* Daily / Weekly / Achievements: 44px buttons + p-1 + border. */}
            <div className={cn(BONE.track, 'mt-4 h-[54px]')} />

            {/* CheckInTrack: heading row, seven 5:7 day slots, the next-line
                sentence and the check-in pill. */}
            <div className="mt-4 rounded-2xl border border-white/10 bg-neutral-900 p-4">
              <div className="flex h-7 items-center justify-between">
                <div className={cn(BONE.bar, 'h-5 w-28')} />
                <div className={cn(BONE.line, 'h-4 w-20')} />
              </div>
              <div className="mt-3 grid grid-cols-7 gap-1.5 sm:gap-2">
                {Array.from({ length: 7 }, (_, i) => (
                  <div
                    key={i}
                    className="aspect-[5/7] rounded-lg border border-white/10 bg-neutral-950"
                  />
                ))}
              </div>
              <div className="mt-3 flex h-4 items-center">
                <div className={cn(BONE.line, 'h-3 w-3/4')} />
              </div>
              <div className="mt-3 h-11 rounded-full bg-white/10" />
            </div>

            {/* Today's tickets: the list heading, then the ticket rows. */}
            <div className="mt-4">
              <div className="flex h-5 items-center justify-between px-1">
                <div className={cn(BONE.bar, 'h-4 w-16')} />
                <div className={cn(BONE.line, 'h-3 w-24')} />
              </div>
              {/* A ticket's height follows its content (stub name, tickets,
                  Claim or Locked); 160px is a typical one. */}
              <div className="mt-2.5 space-y-2.5">
                {Array.from({ length: 4 }, (_, i) => (
                  <div key={i} className={cn(BONE.panel, 'h-40 rounded-xl')} />
                ))}
              </div>
            </div>
          </div>
        </SkeletonReveal>
      </div>
    </SkeletonExit>
  );
}
