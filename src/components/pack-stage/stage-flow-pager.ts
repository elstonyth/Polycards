/**
 * Pack stage: the one pager of the full-page flow. Pure: no DOM, no clock (the caller passes `now` and
 * `scrollY`, and writes `scrollTo` to the window each frame).
 *
 * It owns the whole paged part and the free part's touch:
 *
 * - Stops: [R0, the pack's rests, RL]; a down gesture from the last stop
 *   pages on to the exit end (the start of the free part) when there is one.
 * - Zone: paged up to RL + S / 2 (`edge`), free below.
 * - Wheel and keys: one gesture = one stop, ease-out cubic; 1.5 s, or 1.0 s
 *   only between Pull Odds and Buyback (both ways). |deltaY| < 4 is
 *   ignored; events during a move are swallowed, reverse included; after a
 *   move the wheel stays swallowed until a 120 ms gap or a rise in |deltaY|.
 *   A sideways or Shift wheel is not consumed.
 * - Off a rest, a gesture goes to the next rest that way (so an up notch
 *   between RL and the edge goes to RL, not to Closing).
 * - Touch (paged): the axis locks after 6 px; every move is consumed
 *   whatever the axis (a diagonal never leaves the page off-grid), except a
 *   sideways touch on the Top Hits strip or at the lineup; on release, over
 *   24 px pages one stop, 1.5 s. A touch that starts during a move is
 *   ignored: the move always lands (the opposite of the reference's fault).
 * - Snap: at rest in the paged zone the scroll is always on a rest; a page
 *   left off one glides to the nearest after 150 ms of quiet, in 600 ms.
 *   A cancelled touch has no quiet to wait out: it settles on the next frame
 *   (in the paged zone and the end as above; in the half-empty band over the
 *   lineup, and where Just Pulled fits up to the footer, on the nearest of
 *   RL, the Just Pulled rest and the footer's).
 * - End: below the free part, three rests: the footer in view, the chosen
 *   pack alone (the rise's end) and Last's top (the row back). The zone
 *   stays free; there one gesture (wheel, key, touch over 24 px) is one
 *   move between them, 1.5 s ease-out, with the paged part's swallowing
 *   and snap. A wheel notch that arrives at the footer rests there; only a
 *   notch that starts there pages on. A finger does not stop there: going
 *   down, a swipe over 24 px that starts on the Just Pulled rest (the exit
 *   end) or the footer's, or whose glide would reach the footer, is one
 *   move on to the chosen pack from where it is let go, starting at the
 *   finger's speed (`handOver`). Where Just Pulled is taller than the
 *   view at its rest (`freeFits` false) that move ends on the footer's
 *   rest instead, unless the finger already took the page past it. A swipe
 *   that turns back up the page before the lift never goes on: the page
 *   settles back where the touch began. Up from the footer the wheel and
 *   keys are the free part's (native); a finger mirrors the way down: a
 *   swipe over 24 px up the page that starts on the footer's or the Just
 *   Pulled rest, or whose glide would go above the Just Pulled rest (the
 *   half-empty band over the lineup), is one move to RL from where it is
 *   let go, at the finger's speed. Where Just Pulled is taller than the
 *   view it ends on the Just Pulled rest first, unless the finger already
 *   took the page above it; one that turns back down before the lift
 *   settles back where it began.
 *   The move to Last's top ends on the wrap frame, with no lock to wait out.
 * - Free part: the wheel and the keys are native, except an up notch that
 *   would cross the edge, which pages to RL (whatever its size: never to the
 *   exit end), and, where Just Pulled is all in view, a down key above the
 *   footer, which goes to the next rest below (Just Pulled's, then the
 *   footer's; the browser's PageDown would skip it). Touch follows the finger 1:1 (from RL to the chosen pack's
 *   rest, never past either); on release it glides
 *   `sign * |v|^1.7` px (v: the finger's speed over its moves in the 100 ms
 *   up to the last one, timed by the touch events' own times, as px per 60
 *   Hz frame; 0 when the finger has not moved for 100 ms before the lift),
 *   eased by lerp 0.075 per 60 Hz frame and never slower than 1 px a frame
 *   (the tail would otherwise crawl its last pixels). An
 *   up glide that comes within a few px of the edge pages to RL: scrolling
 *   back always stops at the lineup. A re-measure keeps a glide unless the
 *   paged part changed shape.
 * - Row: up at R0 does nothing; down at R0 enters stop 1 only while entry
 *   is allowed (a pack that cannot be focused swallows it).
 * - Wrap: crossing Last's top going down, by any means, jumps to
 *   R0 plus the overshoot and runs a locked 1.2 s ease-out scroll to R0; the
 *   pager owns it, so no glide or held finger writes an old position after
 *   it, and wheel, keys and touch are swallowed until it ends. `home` runs
 *   the same lock from a paged rest (Home and Escape at the lineup).
 * - A re-measure or a new pack mid-move keeps the move's target by role
 *   (row, a pack stop by its distance from the last one, lineup, exit end).
 */
import {
  WRAP_GUARD_MS,
  wrapScrollAt,
  wrapTarget,
  type FlowTable,
} from './stage-flow';
import {
  AXIS_LOCK_PX,
  PAGE_MS,
  TOUCH_PAGE_PX,
  WHEEL_GAP_MS,
  WHEEL_MIN_DELTA,
  durationFor,
} from './stage-pager';
import { easeOutCubic } from './stage-spin-math';

/** Wheel deltas under this are ignored: one value, the focus pager's. */
export { WHEEL_MIN_DELTA };
/** Quiet before an off-rest page snaps back. */
export const SNAP_QUIET_MS = 150;
/** The snap back's length. */
export const SNAP_MS = 600;
/** Free touch release: glide sign * |v|^1.7 px. */
export const GLIDE_POWER = 1.7;
/** ... eased by this lerp per frame, applied as a 60 Hz rate so frame time cannot change it. */
export const GLIDE_LERP = 0.075;
/** The release speed comes from the moves made in this long before the lift; a finger still this long gets no glide. */
export const RELEASE_HOLD_MS = 100;
/** Moves closer together than this came in a burst (handled behind a long task), not from the finger. */
const BURST_MS = 4;
/** The release speed's limit, px per 60 Hz frame (6000 px/s): a glide of about 2500 px at most. */
export const RELEASE_SPEED_MAX = 100;
/** An up glide this close to the paged edge hands over to the move to RL. */
export const GLIDE_HANDOFF_PX = 4;
/** A glide never moves slower than this, px per 60 Hz frame (its exponential tail would crawl). */
export const GLIDE_MIN_PX = 1;
/** Positions this close count as the same. */
const SAME_PX = 0.5;
const FRAME_MS = 1000 / 60;

export type FlowZone = 'paged' | 'free';

export type FlowPagerTable = {
  /** Paged rests, ascending: index 0 is the row. */
  stops: readonly number[];
  /** The pack's stop kinds (stop k >= 1 is kinds[k - 1]), for durations. */
  kinds: readonly string[];
  /** Down from the last stop pages here (the exit end); null: nothing. */
  exitEnd: number | null;
  /** The paged zone ends here (inclusive). */
  edge: number;
  /** The last stop is the lineup: a sideways touch there is the row's drag. */
  lineup: boolean;
  /** Last's top, the wrap line; absent or null: no wrap. */
  lastTop?: number | null;
  /**
   * The end's rests below the free part, ascending (the footer, the chosen
   * pack, Last's top); absent or empty: the free part runs on to the wrap.
   */
  ends?: readonly number[] | null;
  /**
   * At the exit end the free part's content is all in view (the flow
   * table's `freeFits`); absent: true. False: a touch going down stops at
   * the footer's rest before it goes on to the chosen pack.
   */
  freeFits?: boolean;
};

/** The pager table for a flow table and the chosen pack's stop kinds. */
export function flowPagerTable(
  t: FlowTable,
  kinds: readonly string[],
): FlowPagerTable {
  return {
    stops: t.stops,
    kinds,
    exitEnd: t.exitEnd,
    edge: t.edge,
    lineup: true,
    lastTop: t.lastTop,
    ends: t.ends,
    freeFits: t.freeFits,
  };
}

/**
 * A move from `from` to `to` at progress s (0..1) that starts at speed
 * `m` (px per whole move, from - to sign aside) and ends at rest: the cubic
 * Hermite curve. For 0 <= m <= 3 |to - from| it never turns back and never
 * passes `to`; at m = 3 |to - from| it is the ease-out cubic.
 */
export function handOver(
  from: number,
  to: number,
  m: number,
  s: number,
): number {
  const d = to - from;
  const u = Math.max(0, Math.min(1, s));
  return (
    from +
    d * (3 * u * u - 2 * u * u * u) +
    Math.sign(d) * m * (u - 2 * u * u + u * u * u)
  );
}

/** The free glide's length for a release speed v (px per 60 Hz frame). */
export function glideDistance(v: number): number {
  return v === 0 ? 0 : Math.sign(v) * Math.pow(Math.abs(v), GLIDE_POWER);
}

/**
 * The release speed (px per 60 Hz frame) from the touch samples, by the
 * events' own times: none when the last move was made more than
 * RELEASE_HOLD_MS before the lift at `at` (the finger rested); else first
 * to last over the moves within RELEASE_HOLD_MS of the last one, so one
 * stray move (sideways only, a pixel back) cannot stop or turn a flick; with
 * moves sparser than that, over the last two. A run of moves each under
 * BURST_MS after the one before, ending at the last, was handled in a burst
 * behind a long task (the handling clock), not made that fast: when the
 * measure would start inside it, it starts at the newest move before the
 * run instead; none: no speed. Capped at RELEASE_SPEED_MAX either way.
 */
function releaseSpeed(samples: readonly TouchSample[], at: number): number {
  const n = samples.length;
  const last = samples[n - 1];
  if (!last || at - last.eventTime > RELEASE_HOLD_MS) return 0;
  const recentFrom = samples.findIndex(
    (s) => last.eventTime - s.eventTime <= RELEASE_HOLD_MS,
  );
  let from = n - recentFrom >= 2 ? recentFrom : n - 2;
  let runFrom = n - 1;
  while (
    runFrom > 0 &&
    samples[runFrom]!.eventTime - samples[runFrom - 1]!.eventTime < BURST_MS
  )
    runFrom--;
  if (from >= runFrom) from = runFrom - 1;
  const first = from >= 0 ? samples[from] : undefined;
  if (!first) return 0;
  const v =
    ((last.follow - first.follow) * FRAME_MS) /
    (last.eventTime - first.eventTime);
  return Math.max(-RELEASE_SPEED_MAX, Math.min(RELEASE_SPEED_MAX, v));
}

export type FlowTouchMove = {
  /** The caller cancels the touchmove. */
  consumed: boolean;
  axis: 'x' | 'y' | null;
  /** Free part: write this scroll now (the page follows the finger); else null. */
  scrollTo: number | null;
};

export type FlowPagerFrame = {
  /** Write this to the window scroll this frame; null: leave it. */
  scrollTo: number | null;
  /** The stop index (exit end = stops.length) a move heads to or rests on; null in the free part. */
  target: number | null;
  /** A move or a glide is playing. */
  animating: boolean;
  /** At rest: the caller's loop may sleep. */
  idle: boolean;
  zone: FlowZone;
  /**
   * Ms since the wrap while its lock runs (0 on the wrap frame itself: set
   * `track` to the chosen pack and hide the row UI; it fades back in over
   * `WRAP_UI_FADE_MS`). Absent or null: no wrap running.
   */
  wrap?: number | null;
  /** Which lock runs: the wrap from Last, or `home` from a paged rest; null: none. */
  lock?: FlowLock | null;
};

export type FlowLock = 'wrap' | 'home';

/**
 * What a key did: `moved` (a move started) and `swallowed` (nothing to do
 * here, or a move or the wrap lock runs): the caller cancels the key;
 * `free`: the free part or no flow, the browser's own key.
 */
export type FlowKeyResult = 'moved' | 'swallowed' | 'free';

export interface FlowPager {
  /** A new table (a re-measure or a new pack); a running move keeps its stop. */
  setTable(t: FlowPagerTable | null): void;
  /** Whether a down gesture at the row may enter stop 1. */
  setEntry(allowed: boolean): void;
  zone(scrollY: number): FlowZone;
  /** At or past the footer's rest, where the end pages (its zone stays free). */
  atEnd(scrollY: number): boolean;
  /** A wheel event; true when consumed (caller: preventDefault). */
  wheel(
    dy: number,
    dx: number,
    shift: boolean,
    scrollY: number,
    now: number,
  ): boolean;
  /** Keys: one stop that way. */
  step(dir: 1 | -1, scrollY: number, now: number): FlowKeyResult;
  /** Keys and icons: straight to stop k (the exit end is stops.length). */
  goTo(k: number, scrollY: number, now: number, ms?: number): FlowKeyResult;
  /**
   * Back to the row by the wrap's own lock (1.2 s, ease-out, input
   * swallowed): from a rest in the paged part only.
   */
  home(scrollY: number, now: number): FlowKeyResult;
  /**
   * `strip`: the touch started on the Top Hits strip. `at` (here and on
   * the move and the end): the touch event's own time, on the same clock as
   * `now` (which is when it was handled; the gate passes `now` when the
   * event's clock does not fit); it times the release speed, so moves queued
   * behind a busy page keep their true spacing.
   */
  touchStart(
    x: number,
    y: number,
    scrollY: number,
    now: number,
    at: number,
    o?: { strip?: boolean },
  ): void;
  touchMove(
    x: number,
    y: number,
    scrollY: number,
    now: number,
    at: number,
  ): FlowTouchMove;
  touchEnd(scrollY: number, now: number, at: number): void;
  /** The touch's tracking is dropped (a second finger, a release that is not ours): nothing pages. */
  touchCancel(): void;
  frame(scrollY: number, now: number): FlowPagerFrame;
  busy(): boolean;
  /** The wrap's (or Home's) lock runs. */
  locking(): boolean;
  /** The last gesture (wheel, key, release) was a down gesture at the row that entry refused. */
  refused(): boolean;
}

/** `v0`: the start speed (px/ms) a touch release hands over; absent: an ease-out cubic. */
type Move = { t0: number; from: number; k: number; ms: number; v0?: number };
type Glide = { y: number; target: number; toEdge: boolean };
type Touch = {
  /** It started on the footer's rest or the Just Pulled rest: a swipe up the screen pages on to the chosen pack, one down it to RL. */
  footer: boolean;
  x0: number;
  y0: number;
  y: number;
  start: number;
  axis: 'x' | 'y' | null;
  ignored: boolean;
  free: boolean;
  strip: boolean;
  follow: number;
  /**
   * Where the finger would put the page (the follow, also before the axis
   * locks) at each touch event's own time: those within RELEASE_HOLD_MS of
   * the newest and the one before them, for the release speed.
   */
  samples: TouchSample[];
};
type TouchSample = { eventTime: number; follow: number };
/** `t0` null: starts on the next frame (that frame reports wrap 0). `ms`: its length. */
type Lock = { t0: number | null; from: number; kind: FlowLock; ms: number };

/** The targets a move can have: the stops, the exit end, the end's rests. */
const targetsOf = (t: FlowPagerTable): number[] => [
  ...t.stops,
  ...(t.exitEnd === null ? [] : [t.exitEnd]),
  ...(t.ends ?? []),
];
/** The first end rest's index among the targets. */
const endBaseOf = (t: FlowPagerTable): number =>
  t.stops.length + (t.exitEnd === null ? 0 : 1);
/** The pack's stops in a table (between the row and the lineup or the end). */
const packCount = (t: FlowPagerTable): number =>
  Math.max(0, t.stops.length - 1 - (t.lineup ? 1 : 0));

/**
 * Stop k of table a, by role, in table b: the row stays the row, the lineup
 * the lineup, the exit end the exit end; a pack stop keeps its distance from
 * the last pack stop (Closing), or goes to the nearest pack stop b has.
 */
function sameRole(k: number, a: FlowPagerTable, b: FlowPagerTable): number {
  const lastB = b.stops.length - 1;
  if (k <= 0) return 0;
  const ea = endBaseOf(a);
  if (a.ends?.length && k >= ea) {
    const eb = b.ends ?? [];
    if (eb.length > 0) return endBaseOf(b) + Math.min(k - ea, eb.length - 1);
    return b.exitEnd !== null ? b.stops.length : lastB;
  }
  if (a.exitEnd !== null && k >= a.stops.length)
    return b.exitEnd !== null ? b.stops.length : lastB;
  if (a.lineup && k === a.stops.length - 1)
    return b.lineup ? lastB : b.exitEnd !== null ? b.stops.length : lastB;
  const pb = packCount(b);
  if (pb === 0) return b.lineup ? lastB : 0;
  return Math.max(1, Math.min(pb, pb - (packCount(a) - k)));
}

/** Positions that mean the same in both tables (row, Front, Closing, lineup, exit end), ascending. */
function anchors(a: FlowPagerTable, b: FlowPagerTable): [number[], number[]] {
  const xa: number[] = [];
  const xb: number[] = [];
  const add = (u: number | undefined, v: number | undefined) => {
    if (u === undefined || v === undefined) return;
    const n = xa.length;
    if (n > 0 && (u <= xa[n - 1]! || v <= xb[n - 1]!)) return;
    xa.push(u);
    xb.push(v);
  };
  const pa = packCount(a);
  const pb = packCount(b);
  add(a.stops[0], b.stops[0]);
  if (pa > 0 && pb > 0) {
    add(a.stops[1], b.stops[1]);
    add(a.stops[pa], b.stops[pb]);
  }
  if (a.lineup && b.lineup)
    add(a.stops[a.stops.length - 1], b.stops[b.stops.length - 1]);
  if (a.exitEnd !== null && b.exitEnd !== null) add(a.exitEnd, b.exitEnd);
  const ea = a.ends ?? [];
  const eb = b.ends ?? [];
  for (let j = 0; j < Math.min(ea.length, eb.length); j++) add(ea[j], eb[j]);
  return [xa, xb];
}

/** y on table a, at the same place on table b (piecewise linear between anchors). */
function remap(y: number, a: FlowPagerTable, b: FlowPagerTable): number {
  const [xa, xb] = anchors(a, b);
  const n = xa.length;
  if (n === 0) return y;
  if (n === 1) return y + xb[0]! - xa[0]!;
  let j = 0;
  while (j < n - 2 && y > xa[j + 1]!) j++;
  const u0 = xa[j]!;
  const v0 = xb[j]!;
  return v0 + ((y - u0) * (xb[j + 1]! - v0)) / (xa[j + 1]! - u0);
}

/** How far the paged part moved as a whole from a to b; null when it changed shape. */
function pagedShift(a: FlowPagerTable, b: FlowPagerTable): number | null {
  if (a.stops.length !== b.stops.length || a.lineup !== b.lineup) return null;
  const d = (b.stops[0] ?? 0) - (a.stops[0] ?? 0);
  const same = (u: number, v: number) => Math.abs(v - u - d) < SAME_PX;
  for (let j = 0; j < a.stops.length; j++)
    if (!same(a.stops[j]!, b.stops[j]!)) return null;
  if (!same(a.edge, b.edge)) return null;
  if ((a.exitEnd === null) !== (b.exitEnd === null)) return null;
  if (a.exitEnd !== null && !same(a.exitEnd, b.exitEnd!)) return null;
  return d;
}

export function createFlowPager(): FlowPager {
  let table: FlowPagerTable | null = null;
  /** The stops plus the exit end: the targets a move can have. */
  let ext: number[] = [];
  let duration: (from: number, to: number) => number = () => PAGE_MS;
  let entry = true;
  /** The last gesture asked to enter stop 1 while entry was refused. */
  let refusedEntry = false;
  let move: Move | null = null;
  let glide: Glide | null = null;
  let touch: Touch | null = null;
  /** The wrap's locked scroll to the row. */
  let lock: Lock | null = null;
  let quiet = false;
  /** A touch was cancelled: the next idle frame settles the page at once. */
  let cancelled = false;
  let lastWheel = Number.NEGATIVE_INFINITY;
  let lastAbs = 0;
  let seenY: number | null = null;
  let changedAt = 0;
  let lastFrame: number | null = null;
  /** The scroll the last frame ended on (read or written): the wrap's "before". */
  let prevY: number | null = null;

  const zoneOf = (y: number): FlowZone =>
    table && y <= table.edge ? 'paged' : 'free';
  const endsOf = (): readonly number[] => table?.ends ?? [];
  /** The first end rest's index in `ext`. */
  const endBase = () => ext.length - endsOf().length;
  /** The chosen pack's rest among the end rests (the one before Last's top). */
  const packEnd = () => Math.max(0, endsOf().length - 2);
  /** At or past the footer's rest (the end's paging; the zone stays free). */
  const endAt = (y: number): boolean => {
    const e = endsOf();
    return e.length > 0 && y >= e[0]! - SAME_PX && zoneOf(y) === 'free';
  };
  const locked = () => move !== null || lock !== null;
  const nearest = (y: number): number => {
    const s = table?.stops ?? [];
    let k = 0;
    for (let j = 1; j < s.length; j++)
      if (Math.abs(y - s[j]!) < Math.abs(y - s[k]!)) k = j;
    return k;
  };
  /** The next target that way from y, or null (none, or entry refused). */
  const targetFrom = (y: number, dir: number): number | null => {
    let k: number | null = null;
    const base = endBase();
    if (endAt(y)) {
      // the end pages among its own rests; up from the footer is the free part's
      const e = endsOf();
      if (dir > 0) {
        const j = e.findIndex((v) => v > y + SAME_PX);
        return j < 0 ? null : base + j;
      }
      for (let j = e.length - 1; j >= 0; j--)
        if (e[j]! < y - SAME_PX) return base + j;
      return null;
    }
    if (dir > 0) {
      for (let j = 0; j < base; j++)
        if (ext[j]! > y + SAME_PX) {
          k = j;
          break;
        }
      if (k === 1 && !entry) {
        refusedEntry = true;
        return null;
      }
    } else {
      for (let j = base - 1; j >= 0; j--)
        if (ext[j]! < y - SAME_PX) {
          k = j;
          break;
        }
    }
    return k;
  };
  const begin = (
    y: number,
    k: number,
    now: number,
    ms?: number,
    v0?: number,
  ): boolean => {
    const to = ext[k];
    if (to === undefined || Math.abs(to - y) < SAME_PX) return false;
    const len = ms ?? duration(nearest(y), k);
    move = { t0: now, from: y, k, ms: len };
    if (v0 !== undefined) {
      // starts at the finger's speed: a start speed that would overshoot an
      // ease-out cubic shortens the move to that curve instead
      const v = Math.max(0, v0);
      const d = Math.abs(to - y);
      move.ms = v * len > 3 * d ? (3 * d) / v : len;
      move.v0 = v;
    }
    glide = null;
    return true;
  };
  /**
   * The rest a page left by a cancelled touch settles on, in the free part
   * above the footer: the band over the lineup (where Just Pulled fits, up to
   * the footer) goes to the nearest of RL, the Just Pulled rest and the
   * footer's; null elsewhere (a tall Just Pulled is read freely).
   */
  const bandRest = (y: number): number | null => {
    const xe = table?.exitEnd ?? null;
    if (!table || xe === null || y <= table.edge) return null;
    const e0 = endsOf()[0];
    const fits = table.freeFits !== false && e0 !== undefined;
    if (y >= (fits ? e0! : xe) - SAME_PX) return null;
    const ks = [table.stops.length - 1, table.stops.length];
    if (fits) ks.push(endBase());
    let best = ks[0]!;
    for (const k of ks)
      if (Math.abs(ext[k]! - y) < Math.abs(ext[best]! - y)) best = k;
    return best;
  };
  /** Where a free finger puts the page: between RL and the chosen pack's rest. */
  const followOf = (t: Touch, y: number): number =>
    Math.min(
      endsOf()[packEnd()] ?? Infinity,
      Math.max(
        table?.stops[table.stops.length - 1] ?? table?.edge ?? 0,
        t.start + (t.y0 - y),
      ),
    );
  const atLineup = (y: number): boolean => {
    if (!table || !table.lineup || table.stops.length === 0) return false;
    const rl = table.stops[table.stops.length - 1]!;
    return Math.abs(y - rl) <= table.edge - rl;
  };
  /** A key or icon: the browser's own in the free part, swallowed while locked. */
  const key = (
    scrollY: number,
    k: () => number | null,
    now: number,
    ms?: number,
  ): FlowKeyResult => {
    if (!table) return 'free';
    if (locked()) return 'swallowed';
    const end = endAt(scrollY);
    if (zoneOf(scrollY) === 'free' && !end) return 'free';
    const to = k();
    // up from the footer: the browser's own key scrolls Just Pulled
    if (to === null && end) return 'free';
    return to !== null && begin(scrollY, to, now, ms) ? 'moved' : 'swallowed';
  };
  const out = (
    scrollTo: number | null,
    target: number | null,
    animating: boolean,
    idle: boolean,
    zone: FlowZone,
    wrap: number | null = null,
  ): FlowPagerFrame => {
    if (scrollTo !== null) prevY = scrollTo;
    const kind = wrap === null ? null : (lock?.kind ?? null);
    return { scrollTo, target, animating, idle, zone, wrap, lock: kind };
  };
  /** The wrap: to R0 plus the overshoot now, then the locked scroll to R0. */
  const startWrap = (overshoot: number, now: number): FlowPagerFrame => {
    glide = null;
    move = null;
    const y = (table?.stops[0] ?? 0) + overshoot;
    // landed on the row exactly (a move to Last's top): nothing to ease, no lock to wait out
    const ms = overshoot > SAME_PX ? WRAP_GUARD_MS : 0;
    lock = { t0: now, from: y, kind: 'wrap', ms };
    overshoot = y;
    const t = touch;
    if (t) {
      // a held finger belongs to the lock now: rebased, and it writes nothing
      t.start = t.follow = overshoot;
      t.samples = [];
      t.y0 = t.y;
      t.free = false;
      t.ignored = true;
    }
    return out(overshoot, 0, true, false, zoneOf(overshoot), 0);
  };

  return {
    setTable(t) {
      const old = table;
      if (old && t) {
        if (move) {
          // keep the move's place: its start where it means the same, its stop by role
          move.from = remap(move.from, old, t);
          move.k = sameRole(move.k, old, t);
        }
        if (lock) lock.from = remap(lock.from, old, t);
        const d = pagedShift(old, t);
        if (d === null) glide = null;
        else if (d !== 0) {
          // the scroll origin moved: everything below it moved with it
          if (glide) {
            glide.y += d;
            glide.target += d;
          }
          if (touch && touch.free) {
            touch.start += d;
            touch.follow += d;
            for (const s of touch.samples) s.follow += d;
          }
          if (prevY !== null) prevY += d;
        }
      }
      table = t;
      ext = t ? targetsOf(t) : [];
      duration = t ? durationFor(t.kinds) : () => PAGE_MS;
      if (!t) {
        move = null;
        glide = null;
        touch = null;
        lock = null;
        prevY = null;
      }
    },
    setEntry(allowed) {
      entry = allowed;
    },
    zone: zoneOf,
    atEnd: endAt,
    wheel(dy, dx, shift, scrollY, now) {
      refusedEntry = false;
      if (!table) return false;
      if (shift || Math.abs(dx) > Math.abs(dy)) return false;
      const abs = Math.abs(dy);
      const gap = now - lastWheel;
      const rise = abs > lastAbs;
      lastWheel = now;
      lastAbs = abs;
      if (locked()) {
        quiet = true;
        return true;
      }
      if (quiet) {
        if (gap < WHEEL_GAP_MS && !rise) return true;
        quiet = false;
      }
      if (zoneOf(scrollY) === 'free') {
        glide = null; // the native wheel takes over
        if (endAt(scrollY)) {
          // the end: one notch, one rest; up from the footer is native
          const k = targetFrom(scrollY, dy > 0 ? 1 : -1);
          if (k === null) return false;
          if (abs >= WHEEL_MIN_DELTA && begin(scrollY, k, now)) quiet = true;
          return true;
        }
        if (dy < 0 && scrollY + dy <= table.edge) {
          // to the last paged stop, never past it (the exit end is below it)
          const k = table.stops.length - 1;
          if (k >= 0 && begin(scrollY, k, now)) quiet = true;
          return true;
        }
        const e0 = endsOf()[0];
        if (dy > 0 && e0 !== undefined && scrollY + dy >= e0 - SAME_PX) {
          // arriving at the footer: it rests there, never past it
          if (begin(scrollY, endBase(), now)) quiet = true;
          return true;
        }
        return false;
      }
      if (abs < WHEEL_MIN_DELTA) return true;
      const k = targetFrom(scrollY, dy > 0 ? 1 : -1);
      if (k !== null && begin(scrollY, k, now)) quiet = true;
      return true;
    },
    step(dir, scrollY, now) {
      refusedEntry = false;
      // where Just Pulled is all in view, a down key above the footer goes to
      // the next rest below (Just Pulled's, then the footer's), as a wheel
      // notch arrives at the footer; the browser's own key would skip it
      const e0 = endsOf()[0];
      const xe = table?.exitEnd ?? null;
      if (
        table &&
        dir > 0 &&
        !locked() &&
        table.freeFits !== false &&
        e0 !== undefined &&
        xe !== null &&
        zoneOf(scrollY) === 'free' &&
        scrollY < e0 - SAME_PX
      ) {
        const k = scrollY < xe - SAME_PX ? table.stops.length : endBase();
        return begin(scrollY, k, now) ? 'moved' : 'swallowed';
      }
      return key(scrollY, () => targetFrom(scrollY, dir), now);
    },
    goTo(k, scrollY, now, ms) {
      refusedEntry = false;
      const pick = () =>
        ext.length === 0 ? null : Math.max(0, Math.min(ext.length - 1, k));
      return key(scrollY, pick, now, ms);
    },
    home(scrollY) {
      refusedEntry = false;
      if (!table) return 'free';
      if (locked()) return 'swallowed';
      if (zoneOf(scrollY) === 'free') return 'free';
      glide = null;
      lock = { t0: null, from: scrollY, kind: 'home', ms: WRAP_GUARD_MS };
      return 'moved';
    },
    touchStart(x, y, scrollY, _now, at, o) {
      if (!table) {
        touch = null;
        return;
      }
      glide = null; // a touch stops a glide
      cancelled = false;
      const e0 = endsOf()[0];
      const end = endAt(scrollY);
      // on the footer's rest the finger may scroll Just Pulled back up, so
      // it starts free; further into the end it pages
      const footer = end && scrollY <= e0! + SAME_PX;
      const jp =
        table.exitEnd !== null &&
        Math.abs(scrollY - table.exitEnd) <= GLIDE_HANDOFF_PX;
      touch = {
        footer: footer || jp,
        x0: x,
        y0: y,
        y,
        start: scrollY,
        axis: null,
        ignored: locked(),
        free: zoneOf(scrollY) === 'free' && (!end || footer),
        strip: !!o?.strip,
        follow: scrollY,
        samples: [{ eventTime: at, follow: scrollY }],
      };
    },
    touchMove(x, y, _scrollY, _now, at) {
      const t = touch;
      if (!t || !table) return { consumed: false, axis: null, scrollTo: null };
      t.y = y;
      // every move counts for the speed, those before the axis locks too, at
      // its own event time
      t.samples.push({ eventTime: at, follow: followOf(t, y) });
      // the window back from this move, and the one move before it
      while (
        t.samples.length > 2 &&
        at - t.samples[1]!.eventTime > RELEASE_HOLD_MS
      )
        t.samples.shift();
      // a sideways scroller in the free part (the live ticker): the
      // browser's own gesture, whichever way it goes
      if (t.free && t.strip)
        return { consumed: false, axis: t.axis, scrollTo: null };
      if (t.axis === null) {
        const dx = Math.abs(x - t.x0);
        const dy = Math.abs(y - t.y0);
        if (Math.max(dx, dy) < AXIS_LOCK_PX)
          return { consumed: true, axis: null, scrollTo: null };
        t.axis = dx > dy ? 'x' : 'y';
      }
      if (t.axis === 'x') {
        const consumed = !t.free && !t.strip && !atLineup(t.start);
        return { consumed, axis: 'x', scrollTo: null };
      }
      if (t.ignored || !t.free)
        return { consumed: true, axis: 'y', scrollTo: null };
      t.follow = followOf(t, y);
      return { consumed: true, axis: 'y', scrollTo: t.follow };
    },
    touchEnd(scrollY, now, at) {
      refusedEntry = false;
      const t = touch;
      touch = null;
      if (!t || !table || t.ignored || t.axis !== 'y' || locked()) return;
      if (t.free && t.strip) return;
      if (!t.free) {
        const moved = t.y0 - t.y; // > 0: finger up, page down
        if (Math.abs(moved) <= TOUCH_PAGE_PX) return;
        const k = targetFrom(scrollY, Math.sign(moved));
        if (k !== null) begin(scrollY, k, now, PAGE_MS);
        return;
      }
      const e0 = endsOf()[0];
      const v = releaseSpeed(t.samples, at);
      if (e0 !== undefined && t.y0 - t.y > TOUCH_PAGE_PX) {
        if (v < 0) {
          // the finger turned back up the page before it let go: never on to
          // the pack; the page settles back where the gesture began
          if (Math.abs(t.start - scrollY) >= SAME_PX)
            glide = { y: scrollY, target: t.start, toEdge: false };
          return;
        }
        if (t.footer || scrollY + glideDistance(v) >= e0 - SAME_PX) {
          // up the screen from a rest, or a glide that would reach the
          // footer: one move from where the finger let go, at its speed, on
          // to the chosen pack; where Just Pulled is taller than the view
          // (`freeFits` false) to the footer's rest first
          const k =
            table.freeFits === false && scrollY < e0 - SAME_PX
              ? endBase()
              : endBase() + packEnd();
          begin(scrollY, k, now, PAGE_MS, v / FRAME_MS);
          return;
        }
      }
      const xe = table.exitEnd;
      if (xe !== null && t.y - t.y0 > TOUCH_PAGE_PX) {
        if (v > 0) {
          // turned back down the page before the lift: never on to RL
          if (Math.abs(t.start - scrollY) >= SAME_PX)
            glide = { y: scrollY, target: t.start, toEdge: false };
          return;
        }
        if (t.footer || scrollY + glideDistance(v) < xe - SAME_PX) {
          // down the screen from a rest, or a glide that would go above the
          // Just Pulled rest: one move to RL at the finger's speed; where
          // Just Pulled is taller than the view to its rest first
          const k =
            table.freeFits === false && scrollY > xe + SAME_PX
              ? table.stops.length
              : table.stops.length - 1;
          begin(scrollY, k, now, PAGE_MS, -v / FRAME_MS);
          return;
        }
      }
      const target = Math.min(e0 ?? Infinity, scrollY + glideDistance(v));
      // held against the edge (the follow stops there; the device-pixel
      // grid can leave the scroll a fraction past it): the lineup takes over
      const held =
        t.follow <= table.edge + SAME_PX &&
        scrollY - table.edge <= GLIDE_HANDOFF_PX;
      if (target <= table.edge || held) {
        if (scrollY - table.edge <= GLIDE_HANDOFF_PX) {
          const k = targetFrom(scrollY, -1);
          if (k !== null) begin(scrollY, k, now, SNAP_MS);
        } else glide = { y: scrollY, target: table.edge, toEdge: true };
      } else if (Math.abs(target - scrollY) >= SAME_PX)
        glide = { y: scrollY, target, toEdge: false };
    },
    touchCancel() {
      touch = null;
      cancelled = true;
    },
    frame(scrollY, now) {
      const dt = lastFrame === null ? FRAME_MS : Math.max(0, now - lastFrame);
      lastFrame = now;
      if (!table) {
        prevY = null;
        return {
          scrollTo: null,
          target: null,
          animating: false,
          idle: true,
          zone: 'free',
          wrap: null,
        };
      }
      const r0 = table.stops[0] ?? 0;
      const lastTop = table.lastTop ?? null;
      if (lock) {
        lock.t0 ??= now;
        const elapsed = now - lock.t0;
        if (elapsed >= lock.ms) {
          lock = null;
          seenY = r0;
          changedAt = now;
          return out(r0, 0, false, true, zoneOf(r0));
        }
        const y = wrapScrollAt(elapsed, lock.from, r0);
        return out(y, 0, true, false, zoneOf(y), elapsed);
      }
      // a crossing by any other means (scrollbar, End, the wheel, a finger)
      const crossed = wrapTarget(prevY ?? scrollY, scrollY, lastTop);
      if (crossed !== null) return startWrap(crossed, now);
      prevY = scrollY;
      if (move) {
        const m = move;
        const to = ext[m.k] ?? m.from;
        const t = (now - m.t0) / m.ms;
        if (t >= 1) {
          move = null;
          // the move to the row back lands on Last's top: the wrap, at once
          if (lastTop !== null && to >= lastTop - SAME_PX)
            return startWrap(Math.max(0, to - lastTop), now);
          seenY = to;
          changedAt = now;
          return out(to, m.k, false, true, zoneOf(to));
        }
        const y =
          m.v0 === undefined
            ? m.from + (to - m.from) * easeOutCubic(t)
            : handOver(m.from, to, m.v0 * m.ms, t);
        return out(y, m.k, true, false, zoneOf(y));
      }
      if (glide) {
        const g = glide;
        const gap = g.target - g.y;
        const step = gap * (1 - Math.exp((-GLIDE_LERP * dt) / FRAME_MS));
        // the exponential tail would crawl its last pixels: a floor speed ends it
        const floor = (GLIDE_MIN_PX * dt) / FRAME_MS;
        g.y +=
          Math.abs(step) >= floor
            ? step
            : Math.sign(gap) * Math.min(Math.abs(gap), floor);
        const over = wrapTarget(scrollY, g.y, lastTop);
        if (over !== null) return startWrap(over, now);
        if (g.toEdge && g.y - g.target <= GLIDE_HANDOFF_PX) {
          // close enough: the move to RL takes over instead of a long crawl
          glide = null;
          const k = targetFrom(g.y, -1);
          if (k === null || !begin(g.y, k, now, SNAP_MS)) g.y = g.target;
        } else if (Math.abs(g.target - g.y) < SAME_PX) {
          g.y = g.target;
          glide = null;
        }
        const busy = glide !== null || move !== null;
        return out(g.y, null, busy, !busy, zoneOf(g.y));
      }
      const zone = zoneOf(scrollY);
      if (touch || seenY === null || seenY !== scrollY) {
        seenY = scrollY;
        changedAt = now;
      }
      // a cancelled touch settles at once: the finger is gone, no quiet to wait out
      const settleNow = cancelled && !touch;
      cancelled = false;
      const quietOver = settleNow || now - changedAt >= SNAP_QUIET_MS;
      if (zone === 'free') {
        if (settleNow) {
          const k = bandRest(scrollY);
          if (k !== null && begin(scrollY, k, now, SNAP_MS))
            return out(null, k, true, false, zone);
        }
        if (touch || !endAt(scrollY))
          return out(null, null, false, !touch, zone);
        // the end keeps the snap: a page left off its rests glides to the nearest
        const e = endsOf();
        let j = 0;
        for (let i = 1; i < e.length; i++)
          if (Math.abs(scrollY - e[i]!) < Math.abs(scrollY - e[j]!)) j = i;
        const off = Math.abs(scrollY - e[j]!) > SAME_PX;
        const k = endBase() + j;
        if (off && quietOver && begin(scrollY, k, now, SNAP_MS))
          return out(null, k, true, false, zone);
        return out(null, null, false, !off, zone);
      }
      const k = nearest(scrollY);
      const off = Math.abs(scrollY - table.stops[k]!) > SAME_PX;
      if (off && !touch && quietOver && begin(scrollY, k, now, SNAP_MS))
        return out(null, k, true, false, zone);
      return out(null, k, false, !off && !touch, zone);
    },
    busy: locked,
    locking: () => lock !== null,
    refused: () => refusedEntry,
  };
}
