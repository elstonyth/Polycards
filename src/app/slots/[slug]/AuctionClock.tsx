// src/app/slots/[slug]/AuctionClock.tsx
'use client';

// The shared sell timer (spec decision #9): a lit-shelf strip draining
// STRICTLY linearly with a clear numeral. Warm white → amber ≤10s → pulse ≤5s.
// Honest urgency — no acceleration tricks ever.
import { SELL_COUNTDOWN_SECS } from '@/lib/sell-countdown';
import { cn } from '@/lib/utils';

export function AuctionClock({
  deadlineMs,
  secondsLeft,
  reduced,
}: {
  deadlineMs: number | null;
  secondsLeft: number;
  reduced: boolean;
}) {
  if (deadlineMs === null) return null;
  const pct = Math.max(0, (secondsLeft / SELL_COUNTDOWN_SECS) * 100);
  const amber = secondsLeft <= 10;
  const pulsing = secondsLeft <= 5 && secondsLeft > 0;
  return (
    <div className="flex w-full max-w-[340px] items-center gap-3">
      <div
        aria-hidden
        className="h-1 flex-1 overflow-hidden rounded-full bg-white/10"
      >
        <div
          className={cn(
            'h-full rounded-full',
            amber ? 'bg-amber-400' : 'bg-amber-100/90',
            pulsing && !reduced && 'animate-pulse',
          )}
          style={{
            width: `${pct}%`,
            transition: reduced ? undefined : 'width 250ms linear',
          }}
        />
      </div>
      <p
        className={cn(
          'w-8 text-right text-[13px] font-bold tabular-nums',
          amber ? 'text-amber-300' : 'text-white/70',
        )}
      >
        {Math.max(0, secondsLeft)}s
      </p>
    </div>
  );
}
