'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
// Pure module, NOT '@/lib/data/challenge' — importing the data layer here
// would ship the Medusa SDK and zod to every visitor of this route.
import { formatResetLeft, resetMsLeft } from '@/lib/reset-countdown';

// A client clock a few minutes AHEAD of the server reaches the deadline while
// the server still computes the SAME resetAt, so a single-shot refresh can
// pin forever (see the effect below). Retry every RETRY_MS, up to
// MAX_REFRESHES times, per deadline value — bounded so a server that never
// rolls (challenge disabled mid-week, backend wedged) gets polled a handful
// of times, never per-tick.
const RETRY_MS = 20_000;
const MAX_REFRESHES = 5;

/**
 * Live "resets in …" clock under the challenge hero. `resetAt` is an absolute
 * instant computed server-side, so this only subtracts the visitor's clock.
 *
 * The ticking value is mount-only (`null` first): the server can't know the
 * visitor's clock, and rendering a second-precision string on both sides is a
 * guaranteed hydration mismatch. SSR and no-JS keep the static reset label,
 * which is the same line the page shipped before.
 *
 * A tab left open across the reset gets a `router.refresh()`: past the deadline
 * the pool, the stages and the standings below are LAST week's, and a fresh
 * countdown sitting over stale numbers is worse than either alone.
 */
export function ResetCountdown({
  resetAt,
  label,
}: {
  resetAt: number;
  label: string;
}) {
  const [left, setLeft] = useState<string | null>(null);
  const router = useRouter();
  // Retry state for the deadline currently being refetched. Keyed by the
  // deadline itself rather than cleared per effect run, so a remount (React
  // Strict Mode) can't restart the ladder for the same rollover, while a
  // genuinely new `resetAt` (the server finally rolled) starts a fresh one.
  const refetchState = useRef<{
    for: number;
    count: number;
    at: number;
  } | null>(null);

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      // The deadline the page rendered with just passed: the pool, stages and
      // standings below are last week's now. Refetch the server components —
      // and if the server still returns this SAME resetAt (client clock ahead
      // of the server's), retry every RETRY_MS up to MAX_REFRESHES times. A
      // genuinely new resetAt re-runs this effect and starts a fresh ladder.
      // Testing the instant (not a jump in remaining time) keeps a clock that
      // steps BACKWARDS — an NTP correction, waking from sleep — from reading
      // as a rollover.
      if (now >= resetAt) {
        const s =
          refetchState.current?.for === resetAt ? refetchState.current : null;
        if (!s) {
          refetchState.current = { for: resetAt, count: 1, at: now };
          router.refresh();
        } else if (s.count < MAX_REFRESHES && now - s.at >= RETRY_MS) {
          s.count += 1;
          s.at = now;
          router.refresh();
        }
      }
      const ms = resetMsLeft(resetAt, now);
      setLeft(formatResetLeft(ms));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [resetAt, router]);

  return (
    <p className="mt-3 text-xs font-medium tracking-wide text-neutral-400 uppercase">
      {left === null ? (
        label
      ) : (
        <>
          Resets in{' '}
          <span className="text-neutral-200 tabular-nums">{left}</span>
        </>
      )}
    </p>
  );
}
