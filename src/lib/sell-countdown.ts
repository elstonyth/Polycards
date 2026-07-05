// Keep/sell offer timing at the pack reveal — the deadline now comes from the
// server. POST /store/pulls/:id/reveal returns instant_deadline_ms (anchored to
// revealed_at, capped at rolled_at + grace); the open response carries a
// fallback deadline for when the ping fails. The client only formats the
// remaining seconds.

export const SELL_COUNTDOWN_SECS = 30;

/** Whole seconds remaining until the deadline — partial seconds round up, never below 0. */
export function sellSecondsLeft(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}

/**
 * One shared timer for a whole pull (spec feature 9): the EARLIEST finite
 * per-pull deadline — never shows more time than any pull actually has.
 */
export function sharedDeadlineMs(
  deadlines: (number | null | undefined)[],
): number | null {
  const finite = deadlines.filter(
    (d): d is number => typeof d === 'number' && Number.isFinite(d),
  );
  return finite.length > 0 ? Math.min(...finite) : null;
}
