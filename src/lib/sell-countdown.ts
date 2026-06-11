// Keep/sell offer timing at the pack reveal — pure math, shared with
// PackOpenOverlay. The offer runs 30s from when the card is shown, hard-capped
// at 75s from the open call: the pre-card stages are tap-gated (unbounded), so
// without the cap a lingering user would still see the instant quote after the
// server's 90s window (backend/packages/api/src/modules/packs/buyback-rate.ts)
// lapsed — and be credited the flat rate instead.

export const SELL_COUNTDOWN_SECS = 30;
export const SELL_HARD_CAP_MS = 75_000;

/** Epoch ms when the keep/sell offer expires. */
export function sellOfferDeadlineMs(
  cardShownAtMs: number,
  openedAtMs: number
): number {
  return Math.min(
    cardShownAtMs + SELL_COUNTDOWN_SECS * 1000,
    openedAtMs + SELL_HARD_CAP_MS
  );
}

/** Whole seconds remaining until the deadline — partial seconds round up, never below 0. */
export function sellSecondsLeft(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000));
}
