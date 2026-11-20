/**
 * Pack stage, step 2: the one-shot arrival flag (plan-step2.md 10.10).
 *
 * "All packs" on a cold-loaded pack page marks an arrival right before its
 * `router.push('/')`; the stage that mounts next reads it and plays the
 * float-in instead of appearing at rest. Module-scoped and in memory only: it
 * survives a soft navigation, and a reload or hard navigation loses it, which
 * is right (those are document loads with the loader's own rules). Never a
 * URL parameter, never storage.
 *
 * - `markArrival()`: `flow-address.ts` `leave()`, in the branch where the
 *   focus entry is NOT ours, right before `router.push(basePath)`.
 * - `peekArrival()`: `Stage3dProvider`'s `useState` initializer (no side effect,
 *   so a repeated render sees the same answer).
 * - `takeArrival()`: the provider's layout effect consumes it.
 * Under reduced motion the caller ignores it (no hold, instant).
 */

/** An arrival older than this is stale (the push never landed on the stage). */
export const ARRIVAL_WINDOW_MS = 5000;

let markedAt: number | null = null;

const clock = (): number =>
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();

export function markArrival(now: number = clock()): void {
  markedAt = now;
}

/** True when an arrival was marked within the last 5 s. No side effect. */
export function peekArrival(now: number = clock()): boolean {
  return (
    markedAt !== null &&
    now - markedAt >= 0 &&
    now - markedAt <= ARRIVAL_WINDOW_MS
  );
}

/** As `peekArrival`, then clears the flag (also when stale). */
export function takeArrival(now: number = clock()): boolean {
  const fresh = peekArrival(now);
  markedAt = null;
  return fresh;
}

/** Tests only. */
export function resetArrivalForTests(): void {
  markedAt = null;
}
