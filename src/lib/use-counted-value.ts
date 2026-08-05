'use client';

import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/lib/use-reveal';

/** How long a balance change takes to count to its new figure. */
const DURATION_MS = 650;

/** ease-out-quart — fast off the mark, settles without overshoot. */
const easeOutQuart = (t: number) => 1 - Math.pow(1 - t, 4);

/**
 * The figure to show `elapsed` ms into a count from `from` to `to`. Clamped at
 * both ends, so a late frame can never render past the target. Exported for
 * the unit test — the hook itself needs a DOM.
 */
export function countedFrame(
  from: number,
  to: number,
  elapsed: number,
  duration = DURATION_MS,
): number {
  const t = Math.min(1, Math.max(0, elapsed / duration));
  return from + (to - from) * easeOutQuart(t);
}

export type CountedValue = {
  /** The figure to render this frame (equals `target` once settled). */
  value: number | null;
  /** Direction of the change currently being animated, else null. */
  direction: 'up' | 'down' | null;
};

/**
 * Tweens a money figure toward `target` so a balance change reads as an event
 * rather than a silent swap — the one piece of motion in the app chrome that
 * carries state instead of decoration.
 *
 * First value (login, page load) lands instantly: only *changes* animate.
 * Under `prefers-reduced-motion` the figure snaps and `direction` still fires,
 * so the tint feedback survives without the count.
 */
export function useCountedValue(target: number | null): CountedValue {
  const reduced = usePrefersReducedMotion();
  const [value, setValue] = useState<number | null>(target);
  const [direction, setDirection] = useState<'up' | 'down' | null>(null);
  // The figure currently ON SCREEN — read inside the effect without making
  // `value` a dependency (that would restart the tween every frame). It tracks
  // each frame, not just the settled end: a second change arriving mid-count
  // (three taps in the vault, two packs opened back to back) has to continue
  // from what the customer can see, or the number jumps.
  const shown = useRef<number | null>(target);

  useEffect(() => {
    const from = shown.current;
    if (target == null || from == null || from === target) {
      shown.current = target;
      setValue(target);
      setDirection(null);
      return;
    }

    setDirection(target > from ? 'up' : 'down');

    // The tint always outlives the count by a beat, on both motion paths.
    const holdMs = reduced ? 600 : DURATION_MS + 600;
    const done = setTimeout(() => setDirection(null), holdMs);

    if (reduced) {
      shown.current = target;
      setValue(target);
      return () => clearTimeout(done);
    }

    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      const next = countedFrame(from, target, elapsed);
      shown.current = next;
      setValue(next);
      if (elapsed < DURATION_MS) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(done);
    };
  }, [target, reduced]);

  return { value, direction };
}
