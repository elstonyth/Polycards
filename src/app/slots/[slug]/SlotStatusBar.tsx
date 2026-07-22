// src/app/slots/[slug]/SlotStatusBar.tsx
'use client';

import { cn } from '@/lib/utils';
import type { RecentPull } from '@/lib/data/packs';
import { Meter } from './Meter';

/** Both ends of the recent-wins plate fade out instead of hard-clipping. */
const MARQUEE_FADE =
  'linear-gradient(90deg, transparent, #000 16px, #000 calc(100% - 16px), transparent)';

export function SlotStatusBar({
  balance,
  recent,
  reduced,
}: {
  balance: number | null;
  recent: RecentPull[];
  reduced: boolean;
}) {
  return (
    // min-w-0: as a flex item this plate must SHRINK to the space the top row
    // gives it — without it the w-max marquee track below sets the item's
    // min-content width and pushes the plate past the viewport edge on phones
    // (spec decision #28). The marquee then clips inside via overflow-hidden.
    <div className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-white/10 bg-gradient-to-b from-white/[0.06] to-white/[0.02] px-3 py-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-4 sm:py-2">
      <div className="flex items-center gap-4 sm:gap-5">
        {balance !== null && (
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-white/60">
              Credit
            </p>
            <Meter
              value={balance}
              direction={null}
              reduced={reduced}
              className="font-heading text-base font-bold sm:text-lg"
            />
          </div>
        )}
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-white/60">
            Wins
          </p>
          <p className="font-heading text-base font-bold tabular-nums text-white sm:text-lg">
            {recent.length}
          </p>
        </div>
      </div>
      {/* RECENT WINS marquee — keyframe `sp-scroll-x` lives in globals.css;
          frozen under reduced motion. */}
      {/* Edge fade (style mask): the track is clipped by overflow-hidden, so
          without a mask the marquee guillotines a name mid-word at the plate's
          rounded edge ("PW Pi"). Transparent-to-opaque on both ends makes
          entries fade in and out of the plate instead. */}
      {recent.length > 0 && (
        <div
          className="relative max-w-full overflow-hidden sm:max-w-[55%]"
          style={{
            // -webkit- twin: Safari (including every iOS browser) still only
            // honours the prefixed property, and this machine is designed
            // phone-first — unprefixed alone would leave the guillotined name
            // exactly where it matters most.
            maskImage: MARQUEE_FADE,
            WebkitMaskImage: MARQUEE_FADE,
          }}
        >
          <div
            className={cn(
              'flex w-max gap-4',
              // 100s (was 30s) = slow, calm scroll (spec #41). Linear +
              // translate3d(-50%) over doubled content = seamless, already
              // GPU-composited by the transform animation itself — NO
              // will-change (a permanent will-change on an always-animating
              // marquee holds an extra live layer that taxed the spin budget).
              !reduced && 'animate-[sp-scroll-x_100s_linear_infinite]',
            )}
          >
            {[...recent, ...recent].map((p, i) => (
              <span
                key={`${p.id}-${i}`}
                className="flex shrink-0 items-center gap-1.5 text-[11px] text-white/60"
              >
                <span className="font-medium text-white/75">{p.name}</span>
                <span className="tabular-nums text-white/60">{p.value}</span>
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
