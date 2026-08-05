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
  // Non-null ONLY while a count is in flight; settled renders derive `target`
  // directly, so there is no state to keep in sync with the prop.
  const [frame, setFrame] = useState<number | null>(null);
  const [direction, setDirection] = useState<'up' | 'down' | null>(null);
  // The figure currently ON SCREEN, tracked every frame rather than only at
  // the settled end: a second change arriving mid-count (three taps in the
  // vault, two packs opened back to back) has to continue from what the
  // customer can see, or the number jumps.
  const shown = useRef<number | null>(target);

  useEffect(() => {
    const from = shown.current;
    shown.current = target;
    if (target == null || from == null || from === target) return;

    const dir = target > from ? 'up' : 'down';
    // Every state write below happens from a timer or a frame callback, never
    // synchronously in the effect body — a synchronous setState here is the
    // cascading-render pattern the React Compiler lint rejects.
    const tint = setTimeout(() => setDirection(dir), 0);
    // The tint always outlives the count by a beat, on both motion paths.
    const holdMs = reduced ? 600 : DURATION_MS + 600;
    const done = setTimeout(() => setDirection(null), holdMs);
    if (reduced) {
      return () => {
        clearTimeout(tint);
        clearTimeout(done);
      };
    }

    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const elapsed = now - start;
      const next = countedFrame(from, target, elapsed);
      shown.current = next;
      if (elapsed < DURATION_MS) {
        setFrame(next);
        raf = requestAnimationFrame(tick);
      } else {
        // Settled: drop back to rendering `target` so the displayed figure is
        // the real one, not a float that happens to equal it.
        setFrame(null);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      clearTimeout(tint);
      clearTimeout(done);
      cancelAnimationFrame(raf);
    };
  }, [target, reduced]);

  return { value: frame ?? target, direction };
}
