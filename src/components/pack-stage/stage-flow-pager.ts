/**
 * Pack stage: the one pager of the full-page flow. Pure: no DOM, no clock (the caller passes `now` and
 * `scrollY`, and writes `scrollTo` to the window each frame).
 *
 * Built from the focus pager's rules (`createPager` stays the tested core
 * of the focused view); this one owns the whole paged part and the free
 * part's touch:
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
 * - Free part: the wheel and the keys are native, except an up notch that
 *   would cross the edge, which pages to RL (whatever its size: never to the
 *   exit end). Touch follows the finger 1:1; on release it glides
 *   `sign * |v|^1.7` px (v: the finger's speed over its moves in the 100 ms
 *   up to the last one, timed by the touch events' own times, as px per 60
 *   Hz frame; 0 when the finger has not moved for 100 ms before the lift),
 *   eased by lerp 0.075 per 60 Hz frame. An
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
/** An up glide this close to the paged edge hands over to the move to RL. */
export const GLIDE_HANDOFF_PX = 4;
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
  };
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
 * moves sparser than that, over the last two. Moves that span under
 * BURST_MS were handled in a burst behind a long task (the handling clock),
 * not made that fast: measured from the newest move before the burst
 * instead; none: no speed.
 */
function releaseSpeed(samples: readonly TouchSample[], at: number): number {
  const last = samples[samples.length - 1];
  if (!last || at - last.eventTime > RELEASE_HOLD_MS) return 0;
  const recent = samples.filter(
    (s) => last.eventTime - s.eventTime <= RELEASE_HOLD_MS,
  );
  let first = recent.length >= 2 ? recent[0] : samples[samples.length - 2];
  if (first && last.eventTime - first.eventTime < BURST_MS) {
    first = undefined;
    for (let j = samples.length - 2; j >= 0 && !first; j--)
      if (last.eventTime - samples[j]!.eventTime >= BURST_MS)
        first = samples[j];
  }
  if (!first) return 0;
  return (
    ((last.follow - first.follow) * FRAME_MS) /
    (last.eventTime - first.eventTime)
  );
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
   * `track` to the chosen pack and hide the row UI; fade it in with
   * `wrapUiOpacity`). Absent or null: no wrap running.
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

type Move = { t0: number; from: number; k: number; ms: number };
type Glide = { y: number; target: number; toEdge: boolean };
type Touch = {
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
/** `t0` null: starts on the next frame (that frame reports wrap 0). */
type Lock = { t0: number | null; from: number; kind: FlowLock };

/** The targets a move can have: the stops plus the exit end. */
const targetsOf = (t: FlowPagerTable): number[] =>
  t.exitEnd === null ? [...t.stops] : [...t.stops, t.exitEnd];
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
  let lastWheel = Number.NEGATIVE_INFINITY;
  let lastAbs = 0;
  let seenY: number | null = null;
  let changedAt = 0;
  let lastFrame: number | null = null;
  /** The scroll the last frame ended on (read or written): the wrap's "before". */
  let prevY: number | null = null;

  const zoneOf = (y: number): FlowZone =>
    table && y <= table.edge ? 'paged' : 'free';
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
    if (dir > 0) {
      for (let j = 0; j < ext.length; j++)
        if (ext[j]! > y + SAME_PX) {
          k = j;
          break;
        }
      if (k === 1 && !entry) {
        refusedEntry = true;
        return null;
      }
    } else {
      for (let j = ext.length - 1; j >= 0; j--)
        if (ext[j]! < y - SAME_PX) {
          k = j;
          break;
        }
    }
    return k;
  };
  const begin = (y: number, k: number, now: number, ms?: number): boolean => {
    const to = ext[k];
    if (to === undefined || Math.abs(to - y) < SAME_PX) return false;
    move = { t0: now, from: y, k, ms: ms ?? duration(nearest(y), k) };
    glide = null;
    return true;
  };
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
    if (zoneOf(scrollY) === 'free') return 'free';
    const to = k();
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
    lock = { t0: now, from: y, kind: 'wrap' };
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
        if (dy < 0 && scrollY + dy <= table.edge) {
          // to the last paged stop, never past it (the exit end is below it)
          const k = table.stops.length - 1;
          if (k >= 0 && begin(scrollY, k, now)) quiet = true;
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
      lock = { t0: null, from: scrollY, kind: 'home' };
      return 'moved';
    },
    touchStart(x, y, scrollY, _now, at, o) {
      if (!table) {
        touch = null;
        return;
      }
      glide = null; // a touch stops a glide
      touch = {
        x0: x,
        y0: y,
        y,
        start: scrollY,
        axis: null,
        ignored: locked(),
        free: zoneOf(scrollY) === 'free',
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
      t.samples.push({
        eventTime: at,
        follow: Math.max(table.edge, t.start + (t.y0 - y)),
      });
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
      t.follow = Math.max(table.edge, t.start + (t.y0 - y));
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
      const v = releaseSpeed(t.samples, at);
      const target = scrollY + glideDistance(v);
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
        if (elapsed >= WRAP_GUARD_MS) {
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
          seenY = to;
          changedAt = now;
          return out(to, m.k, false, true, zoneOf(to));
        }
        const y = m.from + (to - m.from) * easeOutCubic(t);
        return out(y, m.k, true, false, zoneOf(y));
      }
      if (glide) {
        const g = glide;
        g.y += (g.target - g.y) * (1 - Math.exp((-GLIDE_LERP * dt) / FRAME_MS));
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
      if (zone === 'free') return out(null, null, false, !touch, zone);
      const k = nearest(scrollY);
      const off = Math.abs(scrollY - table.stops[k]!) > SAME_PX;
      if (
        off &&
        !touch &&
        now - changedAt >= SNAP_QUIET_MS &&
        begin(scrollY, k, now, SNAP_MS)
      )
        return out(null, k, true, false, zone);
      return out(null, k, false, !off && !touch, zone);
    },
    busy: locked,
    locking: () => lock !== null,
    refused: () => refusedEntry,
  };
}
