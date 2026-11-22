/**
 * Pack stage: the paging values the flow pager (stage-flow-pager.ts) and the
 * lineup drag share. One gesture = one stop: 1.5 s, or 1.0 s between Pull
 * Odds and Buyback (the same framing); after a move the wheel stays
 * swallowed until a 120 ms gap; deltas under 4 are ignored; the touch axis
 * locks after 6 px and a release over 24 px pages.
 */

export const PAGE_MS = 1500;
export const SAME_FRAMING_MS = 1000;
export const WHEEL_GAP_MS = 120;
export const AXIS_LOCK_PX = 6;
export const TOUCH_PAGE_PX = 24;
/** Wheel deltas under this are ignored. */
export const WHEEL_MIN_DELTA = 4;

/** The wheel / key / icon duration between stops of these kinds. */
export function durationFor(
  kinds: readonly string[],
): (from: number, to: number) => number {
  return (from, to) => {
    // stop k >= 1 is kinds[k - 1]; a move straight between odds and buyback is
    // the same framing
    const a = kinds[from - 1];
    const b = kinds[to - 1];
    const pair = new Set([a, b]);
    return pair.has('odds') && pair.has('buyback') && pair.size === 2
      ? SAME_FRAMING_MS
      : PAGE_MS;
  };
}
