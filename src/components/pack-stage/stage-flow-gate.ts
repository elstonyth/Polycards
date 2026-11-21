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
  /**
   * A touchstart: `fingers` on the screen, `ours`: the flow's (armed, on).
   * True: tracked. `at` (here and on the move and the end): the event's own
   * time (its timeStamp), which times the release speed when its clock fits;
   * `now`: when it was handled.
   */
  start(
    fingers: number,
    ours: boolean,
    x: number,
    y: number,
    scrollY: number,
    now: number,
    o?: { strip?: boolean; at?: number },
  ): boolean;
  /** A touchmove; true: the caller cancels it. */
  move(
    fingers: number,
    x: number,
    y: number,
    scrollY: number,
    now: number,
    at?: number,
  ): boolean;
  /** A touchend; true: a release that may page (wake the loop). */
  end(scrollY: number, now: number, at?: number): boolean;
  /** A touchcancel: the system took the touch; never a release, nothing pages. */
  cancel(): void;
};

/** How far an event time may run ahead of its handling and still fit: Safari rounds timeStamp to whole ms. */
const EVENT_CLOCK_SLACK_MS = 1;

/**
 * Whether a touch event's own time can time the release speed: on
 * performance.now()'s clock, which the frame loop and `now` use (every
 * current browser), so positive and never in the future. An old browser's
 * epoch time is not: that touch is timed by when it was handled instead.
 */
function eventClockFits(at: number | undefined, now: number): boolean {
  return at !== undefined && at > 0 && at <= now + EVENT_CLOCK_SLACK_MS;
}

/**
 * One finger at a time, while the flow owns the gesture. `held`: the focused
 * view is leaving, and every gesture waits for it.
 */
export function createTouchGate(
  input: FlowTouchInput,
  held: () => boolean,
): TouchGate {
  let touching = false;
  /** This touch's events carry times on the frame loop's clock (decided at its start). */
  let eventClock = false;
  const timeOf = (at: number | undefined, now: number): number =>
    eventClock && at !== undefined ? Math.min(at, now) : now;
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
      eventClock = eventClockFits(o?.at, now);
      input.touchStart(x, y, scrollY, now, timeOf(o?.at, now), {
        strip: o?.strip,
      });
      return true;
    },
    move(fingers, x, y, scrollY, now, at) {
      if (!touching || fingers !== 1) return false;
      return held() || input.touchMove(x, y, scrollY, now, timeOf(at, now));
    },
    end(scrollY, now, at) {
      if (!touching) return false;
      touching = false;
      if (held()) {
        input.touchCancel();
        return false;
      }
      input.touchEnd(scrollY, now, timeOf(at, now));
      return true;
    },
    cancel() {
      if (!touching) return;
      touching = false;
      input.touchCancel();
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

/** A failed load is tried again by a call this long after it at the earliest. */
export const FOCUS_RETRY_MS = 1000;
/**
 * A load still running this long after it began counts as failed: the flow
 * switches off (plain scrolling) while the request goes on, and comes back
 * when it lands.
 */
export const LOAD_DEADLINE_MS = 2500;
/** A down gesture held for the chunk is replayed at most this long after it was made. */
export const HOLD_MAX_MS = 3000;

/** A down gesture kept for the chunk: when it was made and where (the tab and the centred pack). */
export type FocusHold = { at: number; where: string };

/** Whether a held gesture still stands: the same tab and centred pack, within HOLD_MAX_MS. */
export function holdStands(
  hold: FocusHold | null,
  now: number,
  where: string,
): boolean {
  return !!hold && hold.where === where && now - hold.at <= HOLD_MAX_MS;
}

export type FocusLoad<T> = {
  /** The value, loading it (again, after a failure) when needed; null: not now. */
  get(now: number): Promise<T | null>;
  value(): T | null;
  /**
   * A load failed, or has run past its deadline, and none has succeeded
   * since (a retry in flight included).
   */
  failed(): boolean;
  /** A down gesture at the row came before the value: hand it over with it. */
  holdDown(at: number, where: string): void;
  /** The deadline is disarmed (the driver stops). */
  stop(): void;
};

/**
 * The focused view's chunk: one load at a time; a failure, or a load still
 * running at its deadline, is reported (the flow switches off) and never
 * cached, so a later gesture tries again, and a stalled load that lands
 * later is still taken; a down gesture made while it loads is kept (one,
 * the latest) and handed to `ready`, unless the deadline passed first.
 * `load` resolving null means nothing to show yet (the flow is unbound).
 * `after` arms the deadline (the window's timer; none: no deadline).
 */
export function createFocusLoad<T>(d: {
  load(): Promise<T | null>;
  ready(value: T, held: FocusHold | null): void;
  failed(): void;
  after?(ms: number, fn: () => void): () => void;
}): FocusLoad<T> {
  let value: T | null = null;
  let running: Promise<T | null> | null = null;
  /** When the last load failed (the retry gap); null: none to wait for. */
  let failedAt: number | null = null;
  /** The chunk cannot be had: true from a failure until a load succeeds. */
  let unavailable = false;
  let held: FocusHold | null = null;
  let disarm: (() => void) | null = null;
  const settle = () => {
    disarm?.();
    disarm = null;
  };
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
          settle();
          if (v === null) return null;
          value = v;
          unavailable = false;
          const h = held;
          held = null;
          d.ready(v, h);
          return v;
        },
        () => {
          running = null;
          settle();
          failedAt = now;
          unavailable = true;
          held = null;
          d.failed();
          return null;
        },
      );
      running = p;
      disarm =
        d.after?.(LOAD_DEADLINE_MS, () => {
          disarm = null;
          if (running !== p || unavailable) return;
          unavailable = true;
          held = null;
          d.failed();
        }) ?? null;
      return p;
    },
    value: () => value,
    failed: () => unavailable,
    holdDown(at, where) {
      if (value === null && !unavailable) held = { at, where };
    },
    stop: settle,
  };
}

/**
 * The panel past Closing, from the hand-off's progress (0 at Closing, 1 at
 * the lineup), the scroll and where the rise starts (null: not measured):
 * from the hand-off's first frame the panel takes no taps (Closing's
 * controls are leaving with their text); the lineup and its exit are drawn;
 * the free span hides the panel (nothing is drawn there; the 3D keeps the
 * chosen pack); from the rise on (`lap`: the rise,
 * Return and Last) it shows again, still taking no taps.
 */
export function panelState(
  handoff: number,
  scrollY: number,
  exitEnd: number,
  riseStart: number | null = null,
): { inert: boolean; free: boolean; lap: boolean } {
  const h = Math.round(handoff * 1000) / 1000;
  const below = scrollY >= exitEnd - 0.5;
  const lap = below && riseStart !== null && scrollY >= riseStart;
  return { inert: below || h > 0, free: below && !lap, lap };
}
