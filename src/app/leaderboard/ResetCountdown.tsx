'use client';

import { useEffect, useState } from 'react';
import { formatResetLeft, resetMsLeft } from '@/lib/data/challenge';

/**
 * Live "resets in …" clock under the challenge hero. `resetAt` is an absolute
 * instant computed server-side, so this only subtracts the visitor's clock.
 *
 * The ticking value is mount-only (`null` first): the server can't know the
 * visitor's clock, and rendering a second-precision string on both sides is a
 * guaranteed hydration mismatch. SSR and no-JS keep the static reset label,
 * which is the same line the page shipped before.
 */
export function ResetCountdown({
  resetAt,
  label,
}: {
  resetAt: number;
  label: string;
}) {
  const [left, setLeft] = useState<string | null>(null);

  useEffect(() => {
    const tick = () =>
      setLeft(formatResetLeft(resetMsLeft(resetAt, Date.now())));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [resetAt]);

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
