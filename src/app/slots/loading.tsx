// /slots is force-dynamic and awaits the pack catalog before its first byte.
// Mirrors CatalogClient's shell: the header (eyebrow, page name, buyback
// line), then one shelf as the double-bezel bento (rows on a phone). No
// franchise switch — the loader can't know whether there will be one, and a
// phantom switch makes the single-franchise page jump.
import { SkeletonExit } from '@/components/PageTransition';

const TRAY = 'rounded-[2rem] bg-white/[0.04] p-1.5 ring-1 ring-white/10';
const PLATE = 'h-full rounded-[calc(2rem-0.375rem)] bg-neutral-950';

export default function SlotsLoading() {
  return (
    <SkeletonExit>
      <div
        role="status"
        aria-live="polite"
        className="mx-auto w-full animate-pulse px-fluid pb-16 pt-6 motion-reduce:animate-none md:pb-24 md:pt-10"
      >
        <span className="sr-only">Loading packs</span>

        {/* Header */}
        <div className="h-7 w-44 rounded-full bg-white/[0.06]" />
        <div className="mt-4 h-10 w-64 rounded-xl bg-neutral-800 md:h-20 md:w-[28rem]" />
        <div className="mt-4 h-4 w-full max-w-xl rounded bg-neutral-900" />

        {/* One shelf */}
        <div className="mt-12 md:mt-24">
          <div className="h-7 w-24 rounded-full bg-white/[0.06]" />
          <div className="mt-3 h-8 w-56 rounded-lg bg-neutral-800 md:h-10" />

          {/* lg: the bento, a tall lead with four beside it */}
          <div className="mt-8 hidden grid-cols-12 gap-4 lg:grid">
            <div className={`col-span-6 row-span-2 ${TRAY}`}>
              <div className={PLATE} />
            </div>
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className={`col-span-3 h-[22rem] ${TRAY}`}>
                <div className={PLATE} />
              </div>
            ))}
          </div>

          {/* Tablet: three across */}
          <div className="mt-8 hidden grid-cols-3 gap-4 md:grid lg:hidden">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i} className={`h-[24rem] ${TRAY}`}>
                <div className={PLATE} />
              </div>
            ))}
          </div>

          {/* Phones: rows */}
          <div className="mt-5 flex flex-col gap-3 md:hidden">
            {Array.from({ length: 5 }, (_, i) => (
              <div
                key={i}
                className="h-[5.25rem] rounded-[1.5rem] bg-white/[0.04] p-1 ring-1 ring-white/10"
              >
                <div className="h-full rounded-[calc(1.5rem-0.25rem)] bg-neutral-950" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </SkeletonExit>
  );
}
