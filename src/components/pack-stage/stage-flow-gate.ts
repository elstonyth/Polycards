/**
 * Pack stage: the flow driver's decisions, as pure code (no DOM, no clock),
 * so the spin chunk's listeners stay thin and every rule here is tested.
 */
import type { FlowInput } from './stage-flow-input';

/** What the touch gate drives. */
export type FlowTouchInput = Pick<
  FlowInput,
  'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel'
>;

export type TouchGate = {
  /** A touchstart: `fingers` on the screen, `ours`: the flow's (armed, on). True: tracked. */
  start(
    fingers: number,
    ours: boolean,
    x: number,
    y: number,
    scrollY: number,
    now: number,
    o?: { strip?: boolean },
  ): boolean;
  /** A touchmove; true: the caller cancels it. */
  move(
    fingers: number,
    x: number,
    y: number,
    scrollY: number,
    now: number,
  ): boolean;
  /** A touchend or touchcancel; true: a release that may page (wake the loop). */
  end(scrollY: number, now: number): boolean;
};

/**
 * One finger at a time, while the flow owns the gesture. `held`: the focused
 * view is leaving, and every gesture waits for it.
 */
export function createTouchGate(
  input: FlowTouchInput,
  held: () => boolean,
): TouchGate {
  let touching = false;
  return {
    start(fingers, ours, x, y, scrollY, now, o) {
      if (fingers !== 1 || !ours) {
        // a second finger (a pinch) or a touch that is not ours: whatever
        // the flow was tracking is dropped, never left half-open
        if (touching) input.touchCancel();
        touching = false;
        return false;
      }
      touching = true;
      input.touchStart(x, y, scrollY, now, o);
      return true;
    },
    move(fingers, x, y, scrollY, now) {
      if (!touching || fingers !== 1) return false;
      return held() || input.touchMove(x, y, scrollY, now);
    },
    end(scrollY, now) {
      if (!touching) return false;
      touching = false;
      if (held()) {
        input.touchCancel();
        return false;
      }
      input.touchEnd(scrollY, now);
      return true;
    },
  };
}

/**
 * Whether the flow runs (data-flow-on): never under reduced motion, for an
 * empty stage, or while the focused view's chunk cannot be had (the page then
 * reads as plain scrolling); switched on only while the visitor is still at
 * the row, so a page already scrolled down never jumps; once on, it stays on.
 */
export function flowSwitch(o: {
  reduced: boolean;
  empty: boolean;
  focusFailed: boolean;
  was: boolean;
  scrollY: number;
  r0: number;
  panel: number;
}): boolean {
  if (o.reduced || o.empty || o.focusFailed) return false;
  return o.was || o.scrollY <= o.r0 + o.panel / 2;
}

/** A failed load is tried again by a call this long after it at the earliest [ours]. */
export const FOCUS_RETRY_MS = 1000;

export type FocusLoad<T> = {
  /** The value, loading it (again, after a failure) when needed; null: not now. */
  get(now: number): Promise<T | null>;
  value(): T | null;
  /** A load failed and none has succeeded since (a retry in flight included). */
  failed(): boolean;
  /** A down gesture at the row came before the value: hand it over with it. */
  holdDown(): void;
};

/**
 * The focused view's chunk: one load at a time; a failure is reported (the
 * flow switches off) and never cached, so a later gesture tries again; a down
 * gesture made while it loads is kept (one) and handed to `ready`.
 * `load` resolving null means nothing to show yet (the flow is unbound).
 */
export function createFocusLoad<T>(d: {
  load(): Promise<T | null>;
  ready(value: T, down: boolean): void;
  failed(): void;
}): FocusLoad<T> {
  let value: T | null = null;
  let running: Promise<T | null> | null = null;
  /** When the last load failed (the retry gap); null: none to wait for. */
  let failedAt: number | null = null;
  /** The chunk cannot be had: true from a failure until a load succeeds. */
  let unavailable = false;
  let down = false;
  return {
    get(now) {
      if (value !== null) return Promise.resolve(value);
      if (running) return running;
      if (failedAt !== null && now - failedAt < FOCUS_RETRY_MS)
        return Promise.resolve(null);
      failedAt = null;
      const p = d.load().then(
        (v) => {
          running = null;
          if (v === null) return null;
          value = v;
          unavailable = false;
          const held = down;
          down = false;
          d.ready(v, held);
          return v;
        },
        () => {
          running = null;
          failedAt = now;
          unavailable = true;
          down = false;
          d.failed();
          return null;
        },
      );
      running = p;
      return p;
    },
    value: () => value,
    failed: () => unavailable,
    holdDown() {
      if (value === null) down = true;
    },
  };
}

/**
 * The panel past Closing, from the focused pack's fade (0 shown, 1 gone) and
 * the scroll: a fading pack takes no taps (nothing on it can be tapped while
 * it goes, nor once it is invisible); a gone pack is not drawn (the 3D sleeps
 * and, after a while, lets its packs go); the free part hides the panel.
 */
export function panelState(
  fade: number,
  scrollY: number,
  exitEnd: number,
): { inert: boolean; free: boolean; shown: boolean } {
  const f = Math.round(fade * 1000) / 1000;
  const free = scrollY >= exitEnd - 0.5;
  return { inert: free || f > 0, free, shown: !free && f < 1 };
}
