// Pack detail is force-dynamic and awaits three backend reads (pack, detail,
// recent pulls) before its first byte. Mirrors PackDetailClient's shell: back
// link, then the stage column (pack header + stage) beside the configurator
// with the picker's two-column pack tiles, then Top Hits (one ranked row).
import { SkeletonExit } from '@/components/PageTransition';

export default function PackDetailLoading() {
  return (
    <SkeletonExit>
      <div
        role="status"
        aria-live="polite"
        className="mx-auto w-full animate-pulse px-fluid pb-28 pt-4 motion-reduce:animate-none lg:pb-4"
      >
        <span className="sr-only">Loading pack</span>

        <div className="mb-4 h-4 w-24 rounded bg-neutral-800" />

        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1.55fr_1fr]">
          {/* Stage column: the pack header, then the stage */}
          <div className="flex min-w-0 flex-col gap-4">
            {/* Header: name, then the facts row */}
            <div className="flex flex-col gap-3">
              <div className="h-9 w-56 rounded-lg bg-neutral-800 lg:h-12 lg:w-80" />
              <div className="flex gap-6">
                {Array.from({ length: 3 }, (_, i) => (
                  <div key={i} className="flex flex-col gap-1.5">
                    <div className="h-3 w-14 rounded bg-neutral-900" />
                    <div className="h-4 w-20 rounded bg-neutral-800" />
                  </div>
                ))}
              </div>
            </div>
            {/* Stage */}
            <div className="aspect-[36/25] rounded-[2rem] bg-white/[0.04] p-1.5 ring-1 ring-white/10">
              <div className="h-full rounded-[calc(2rem-0.375rem)] bg-neutral-900" />
            </div>
          </div>
          {/* Configurator: category switch, type chips, pack tiles, open */}
          <div className="flex flex-col gap-4 rounded-[2rem] bg-white/[0.04] p-5 ring-1 ring-white/10 sm:p-6">
            <div className="h-12 rounded-full bg-neutral-900" />
            <div className="flex gap-2">
              <div className="h-11 w-24 rounded-full bg-neutral-800" />
              <div className="h-11 w-24 rounded-full bg-neutral-900" />
              <div className="h-11 w-24 rounded-full bg-neutral-900" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              {Array.from({ length: 4 }, (_, i) => (
                <div
                  key={i}
                  className="h-16 rounded-xl border border-white/10 bg-neutral-900"
                />
              ))}
            </div>
            <div className="hidden h-12 rounded-full bg-neutral-800 lg:block" />
          </div>
        </div>

        {/* Top Hits: the heading, then the one ranked row */}
        <div className="mt-10 h-6 w-20 rounded-full bg-neutral-900" />
        <div className="mt-3 h-9 w-40 rounded-lg bg-neutral-800" />
        <div className="mt-5 flex gap-3 overflow-hidden">
          {Array.from({ length: 7 }, (_, i) => (
            <div
              key={i}
              className="h-72 w-[44%] shrink-0 rounded-[1.5rem] bg-white/[0.04] ring-1 ring-white/10 sm:h-96 sm:w-52"
            />
          ))}
        </div>
      </div>
    </SkeletonExit>
  );
}
