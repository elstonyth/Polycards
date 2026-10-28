import { useEffect, useRef, useState } from 'react';

/** The value `elapsedMs` into an ease-out-expo count from `from` to `to`. */
export const countUpAt = (
  from: number,
  to: number,
  elapsedMs: number,
  durationMs: number,
): number => {
  if (durationMs <= 0 || elapsedMs >= durationMs) return to;
  const t = Math.max(0, elapsedMs) / durationMs;
  return from + (to - from) * (1 - Math.pow(2, -10 * t));
};

export const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * Counts from the last shown value to `target` whenever it changes. Under
 * reduced motion it shows the target at once. requestAnimationFrame stalls in
 * background tabs, so a timer also lands the final value: a number is never
 * left half-counted.
 */
export const useCountUp = (target: number, durationMs = 900): number => {
  // First paint counts up from 0; under reduced motion it starts final.
  const [value, setValue] = useState(() =>
    prefersReducedMotion() ? target : 0,
  );
  const shown = useRef(value);

  useEffect(() => {
    const from = shown.current;
    if (from === target || prefersReducedMotion()) {
      shown.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const next = countUpAt(from, target, now - start, durationMs);
      shown.current = next;
      setValue(next);
      if (next !== target) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    const done = window.setTimeout(() => {
      cancelAnimationFrame(frame);
      shown.current = target;
      setValue(target);
    }, durationMs + 60);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(done);
    };
  }, [target, durationMs]);

  return value;
};
