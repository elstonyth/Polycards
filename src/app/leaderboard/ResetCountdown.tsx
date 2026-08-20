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
  // Last tick's remaining ms. Cleared per effect run so the week-long jump that
  // arrives WITH the refreshed `resetAt` can't be read as a second rollover.
  const prevMs = useRef<number | null>(null);

  useEffect(() => {
    prevMs.current = null;
    const tick = () => {
      const ms = resetMsLeft(resetAt, Date.now());
      // Remaining time only ever grows when the deadline rolled to next week —
      // i.e. the week this page rendered just ended. Refetch the server
      // components once; the new `resetAt` re-runs this effect.
      if (prevMs.current !== null && ms > prevMs.current) router.refresh();
      prevMs.current = ms;
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
