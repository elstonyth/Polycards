/**
 * Pack stage: the focused pack's paging (plan-focus-ciao section 5). Pure: no
 * DOM, no clock (the caller passes `now` and `scrollY`); the spin chunk's one
 * set of listeners feeds it while a pack is focused, and writes `scrollTo` to
 * the window each frame.
 *
 * Stops are scroll positions: stop 0 is the row (leaving the focus), stop k
 * rests on the k-th focus stop. The focus value `F` is the scroll's position
 * between them (stop k + the fraction to k + 1).
 *
 * - One gesture = one stop, ease-out cubic; 1.5 s, or 1.0 s between Pull
 *   Odds and Buyback (the same framing; wheel, keys and icons). Touch: 1.5 s
 *   every move.
 * - Wheel: every vertical event is consumed; |deltaY| < 4 is ignored; events
 *   during a move are swallowed, reverse ones included. After a move ends,
 *   wheel events stay swallowed until a 120 ms gap or a rise in |deltaY|
 *   (a trackpad's momentum tail never starts a second page). A sideways
 *   wheel (|deltaX| > |deltaY|, or Shift) is not consumed.
 * - Touch: the axis locks after 6 px; vertical moves are consumed, so the
 *   page never follows a held finger; on release, over 24 px pages one stop
 *   that way, less stays. A touch during a move is ignored. A horizontal
 *   touch is not consumed (the Top Hits strip scrolls natively).
 * - Forward past the last stop: nothing.
 */
import { easeOutCubic } from './stage-spin-driver';

export const PAGE_MS = 1500;
export const SAME_FRAMING_MS = 1000;
export const WHEEL_GAP_MS = 120;
export const AXIS_LOCK_PX = 6;
export const TOUCH_PAGE_PX = 24;
const WHEEL_MIN_DELTA = 4;

export type PagerFrame = {
  /** Write this to the window scroll this frame; null: leave it. */
  scrollTo: number | null;
  /** The focus value at the scroll shown this frame. */
  focus: number;
  /** The stop a move is heading to, or the stop at rest. */
  target: number;
  animating: boolean;
  /** At rest on a stop: the caller's loop may sleep. */
  idle: boolean;
};

export interface Pager {
  /** Stop scroll positions, ascending (index 0 = the row). */
  setStops(tops: readonly number[] | null): void;
  /** Durations by the stops a move joins (default: 1.5 s every move). */
  setDuration(ms: (from: number, to: number) => number): void;
  wheel(
    dy: number,
    dx: number,
    shift: boolean,
    scrollY: number,
    now: number,
  ): boolean;
  touchStart(x: number, y: number, now: number): void;
  touchMove(x: number, y: number): boolean;
  touchEnd(scrollY: number, now: number): void;
  /** Icons and keys: a move straight to stop k (one duration). False when locked or there. */
  goTo(k: number, scrollY: number, now: number, ms?: number): boolean;
  frame(scrollY: number, now: number): PagerFrame;
  /** The focus value at a scroll position. */
  focusAt(scrollY: number): number;
  busy(): boolean;
}

type Move = { t0: number; from: number; to: number; k: number; ms: number };
type Touch = {
  x0: number;
  y0: number;
  y: number;
  axis: 'x' | 'y' | null;
  ignored: boolean;
};

export function createPager(): Pager {
  let stops: number[] = [];
  let duration: (from: number, to: number) => number = () => PAGE_MS;
  let move: Move | null = null;
  let touch: Touch | null = null;
  let quiet = false;
  let lastWheel = Number.NEGATIVE_INFINITY;
  let lastAbs = 0;
  let restK = 0;

  const focusAt = (y: number): number => {
    const n = stops.length;
    if (n === 0) return 0;
    if (y <= stops[0]!) return 0;
    for (let k = 0; k < n - 1; k++) {
      const a = stops[k]!;
      const b = stops[k + 1]!;
      if (y <= b) return k + (b > a ? (y - a) / (b - a) : 1);
    }
    return n - 1;
  };
  const nearest = (y: number): number => {
    let k = 0;
    for (let j = 1; j < stops.length; j++)
      if (Math.abs(y - stops[j]!) < Math.abs(y - stops[k]!)) k = j;
    return k;
  };
  const begin = (
    from: number,
    k: number,
    now: number,
    ms?: number,
  ): boolean => {
    if (stops.length === 0) return false;
    const kk = Math.max(0, Math.min(stops.length - 1, k));
    const to = stops[kk]!;
    const at = Math.round(focusAt(from));
    if (Math.abs(to - from) < 0.5) return false;
    move = { t0: now, from, to, k: kk, ms: ms ?? duration(at, kk) };
    return true;
  };

  return {
    setStops(tops) {
      stops = tops ? [...tops] : [];
      if (!tops) {
        move = null;
        touch = null;
      }
    },
    setDuration(ms) {
      duration = ms;
    },
    wheel(dy, dx, shift, scrollY, now) {
      if (stops.length === 0) return false;
      if (shift || Math.abs(dx) > Math.abs(dy)) return false;
      const abs = Math.abs(dy);
      const gap = now - lastWheel;
      const rise = abs > lastAbs;
      lastWheel = now;
      lastAbs = abs;
      if (move) {
        quiet = true;
        return true;
      }
      if (quiet) {
        if (gap < WHEEL_GAP_MS && !rise) return true;
        quiet = false;
      }
      if (abs < WHEEL_MIN_DELTA) return true;
      const k = nearest(scrollY) + (dy > 0 ? 1 : -1);
      if (k < 0 || k > stops.length - 1) return true;
      if (begin(scrollY, k, now)) quiet = true;
      return true;
    },
    touchStart(x, y) {
      if (stops.length === 0) {
        touch = null;
        return;
      }
      touch = { x0: x, y0: y, y, axis: null, ignored: move !== null };
    },
    touchMove(x, y) {
      const t = touch;
      if (!t) return false;
      t.y = y;
      if (t.axis === null) {
        const dx = Math.abs(x - t.x0);
        const dy = Math.abs(y - t.y0);
        if (Math.max(dx, dy) < AXIS_LOCK_PX) return true;
        t.axis = dx > dy ? 'x' : 'y';
      }
      return t.axis === 'y';
    },
    touchEnd(scrollY, now) {
      const t = touch;
      touch = null;
      if (!t || t.ignored || t.axis !== 'y' || move) return;
      const moved = t.y0 - t.y; // > 0: finger up, page down
      if (Math.abs(moved) <= TOUCH_PAGE_PX) return;
      const k = nearest(scrollY) + Math.sign(moved);
      if (k < 0 || k > stops.length - 1) return;
      begin(scrollY, k, now, PAGE_MS);
    },
    goTo(k, scrollY, now, ms) {
      if (move) return false;
      return begin(scrollY, k, now, ms);
    },
    frame(scrollY, now) {
      if (move) {
        const t = (now - move.t0) / move.ms;
        const y = move.from + (move.to - move.from) * easeOutCubic(t);
        if (t >= 1) {
          restK = move.k;
          const to = move.to;
          move = null;
          return {
            scrollTo: to,
            focus: focusAt(to),
            target: restK,
            animating: false,
            idle: true,
          };
        }
        return {
          scrollTo: y,
          focus: focusAt(y),
          target: move.k,
          animating: true,
          idle: false,
        };
      }
      restK = stops.length ? nearest(scrollY) : 0;
      return {
        scrollTo: null,
        focus: focusAt(scrollY),
        target: restK,
        animating: false,
        idle: true,
      };
    },
    focusAt,
    busy: () => move !== null,
  };
}

/** The wheel / key / icon duration between stops of these kinds (section 5). */
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
