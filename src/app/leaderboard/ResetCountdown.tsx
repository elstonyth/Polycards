'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
// Pure module, NOT '@/lib/data/challenge' — importing the data layer here
// would ship the Medusa SDK and zod to every visitor of this route.
import { formatResetLeft, resetMsLeft } from '@/lib/reset-countdown';

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
  // The deadline already refetched for. Keyed by the deadline itself rather than
  // cleared per effect run, so a remount (React Strict Mode) can't refetch the
  // same rollover twice, while the refreshed `resetAt` still arms the next one.
  const refetchedFor = useRef<number | null>(null);

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      // The deadline the page rendered with just passed: the pool, stages and
      // standings below are last week's now. Refetch the server components
      // once — the new `resetAt` re-runs this effect and arms the next one.
      // Testing the instant (not a jump in remaining time) keeps a clock that
      // steps BACKWARDS — an NTP correction, waking from sleep — from reading
      // as a rollover.
      if (refetchedFor.current !== resetAt && now >= resetAt) {
        refetchedFor.current = resetAt;
        router.refresh();
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
