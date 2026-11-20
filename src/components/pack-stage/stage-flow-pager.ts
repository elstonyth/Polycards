/**
 * Pack stage: the one pager of the full-page flow (full-flow plan sections
 * 2.2, 2.5 and 2.9). Pure: no DOM, no clock (the caller passes `now` and
 * `scrollY`, and writes `scrollTo` to the window each frame).
 *
 * Built from the focus pager's rules (`createPager` stays the tested core
 * of the focused view); this one owns the whole paged part and the free
 * part's touch:
 *
 * - Stops: [R0, the pack's rests, RL]; a down gesture from the last stop
 *   pages on to the exit end (the start of the free part) when there is one.
 * - Zone: paged up to RL + S / 2 (`edge`), free below [ours, plan 2.2].
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
 * - Free part: the wheel is native, except an up notch that would cross the
 *   edge, which pages to RL. Touch follows the finger 1:1; on release it
 *   glides `sign * |v|^1.7` px (v: the scroll change in the last frame),
 *   eased by lerp 0.075 per 60 Hz frame. An up glide is held at the edge,
 *   then pages to RL: scrolling back always stops at the lineup.
 * - Row: up at R0 does nothing; down at R0 enters stop 1 only while entry
 *   is allowed (a pack that cannot be focused swallows it).
 */
import { flowStops, indexAt, positionAt, type FlowTable } from './stage-flow';
import {
  AXIS_LOCK_PX,
  PAGE_MS,
  TOUCH_PAGE_PX,
  WHEEL_GAP_MS,
  durationFor,
} from './stage-pager';
import { easeOutCubic } from './stage-spin-driver';

/** Wheel deltas under this are ignored [measured D §B] (the focus pager keeps an unexported copy). */
export const WHEEL_MIN_DELTA = 4;
/** Quiet before an off-rest page snaps back [ours: the focus kit's SNAP_QUIET_MS, not exported there]. */
export const SNAP_QUIET_MS = 150;
/** The snap back's length [ours: the focus kit's SNAP_MS, not exported there]. */
export const SNAP_MS = 600;
/** Free touch release: glide sign * |v|^1.7 px [code, P §C]. */
export const GLIDE_POWER = 1.7;
/** ... eased by this lerp per frame [code, P §C], applied as a 60 Hz rate so frame time cannot change it [ours]. */
export const GLIDE_LERP = 0.075;
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
};

/** The pager table for a flow table and the chosen pack's stop kinds. */
export function flowPagerTable(
  t: FlowTable,
  kinds: readonly string[],
): FlowPagerTable {
  return {
    stops: flowStops(t),
    kinds,
    exitEnd: t.exitEnd,
    edge: t.edge,
    lineup: true,
  };
}

/** The free glide's length for a last-frame scroll change v (px). */
export function glideDistance(v: number): number {
  return v === 0 ? 0 : Math.sign(v) * Math.pow(Math.abs(v), GLIDE_POWER);
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
};

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
  /** Keys: one stop that way. False when nothing moves. */
  step(dir: 1 | -1, scrollY: number, now: number): boolean;
  /** Keys and icons: straight to stop k. False when moving or already there. */
  goTo(k: number, scrollY: number, now: number, ms?: number): boolean;
  /** `strip`: the touch started on the Top Hits strip. */
  touchStart(
    x: number,
    y: number,
    scrollY: number,
    now: number,
    o?: { strip?: boolean },
  ): void;
  touchMove(x: number, y: number, scrollY: number, now: number): FlowTouchMove;
  touchEnd(scrollY: number, now: number): void;
  frame(scrollY: number, now: number): FlowPagerFrame;
  busy(): boolean;
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
  prevFollow: number;
  v: number;
};

export function createFlowPager(): FlowPager {
  let table: FlowPagerTable | null = null;
  /** The stops plus the exit end: the targets a move can have. */
  let ext: number[] = [];
  let duration: (from: number, to: number) => number = () => PAGE_MS;
  let entry = true;
  let move: Move | null = null;
  let glide: Glide | null = null;
  let touch: Touch | null = null;
  let quiet = false;
  let lastWheel = Number.NEGATIVE_INFINITY;
  let lastAbs = 0;
  let seenY: number | null = null;
  let changedAt = 0;
  let lastFrame: number | null = null;

  const zoneOf = (y: number): FlowZone =>
    table && y <= table.edge ? 'paged' : 'free';
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
      if (k === 1 && !entry) return null;
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
    const fromK = Math.round(indexAt(y, table?.stops ?? []));
    move = { t0: now, from: y, k, ms: ms ?? duration(fromK, k) };
    glide = null;
    return true;
  };
  const atLineup = (y: number): boolean => {
    if (!table || !table.lineup || table.stops.length === 0) return false;
    const rl = table.stops[table.stops.length - 1]!;
    return Math.abs(y - rl) <= table.edge - rl;
  };

  return {
    setTable(t) {
      if (move && t) {
        // keep the move's place: its start by fractional index, its stop by number
        const next =
          t.exitEnd === null ? [...t.stops] : [...t.stops, t.exitEnd];
        move.from = positionAt(indexAt(move.from, ext), next);
        move.k = Math.min(move.k, next.length - 1);
      }
      table = t;
      ext = t
        ? t.exitEnd === null
          ? [...t.stops]
          : [...t.stops, t.exitEnd]
        : [];
      duration = t ? durationFor(t.kinds) : () => PAGE_MS;
      glide = null;
      if (!t) {
        move = null;
        touch = null;
      }
    },
    setEntry(allowed) {
      entry = allowed;
    },
    zone: zoneOf,
    wheel(dy, dx, shift, scrollY, now) {
      if (!table) return false;
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
      if (zoneOf(scrollY) === 'free') {
        glide = null; // the native wheel takes over
        if (dy < 0 && scrollY + dy <= table.edge) {
          const k = targetFrom(scrollY, -1);
          if (k !== null && begin(scrollY, k, now)) quiet = true;
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
      if (!table || move) return false;
      const k = targetFrom(scrollY, dir);
      return k !== null && begin(scrollY, k, now);
    },
    goTo(k, scrollY, now, ms) {
      if (!table || move || ext.length === 0) return false;
      return begin(scrollY, Math.max(0, Math.min(ext.length - 1, k)), now, ms);
    },
    touchStart(x, y, scrollY, _now, o) {
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
        ignored: move !== null,
        free: zoneOf(scrollY) === 'free',
        strip: !!o?.strip,
        follow: scrollY,
        prevFollow: scrollY,
        v: 0,
      };
    },
    touchMove(x, y) {
      const t = touch;
      if (!t || !table) return { consumed: false, axis: null, scrollTo: null };
      t.y = y;
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
    touchEnd(scrollY, now) {
      const t = touch;
      touch = null;
      if (!t || !table || t.ignored || t.axis !== 'y' || move) return;
      if (!t.free) {
        const moved = t.y0 - t.y; // > 0: finger up, page down
        if (Math.abs(moved) <= TOUCH_PAGE_PX) return;
        const k = targetFrom(scrollY, Math.sign(moved));
        if (k !== null) begin(scrollY, k, now, PAGE_MS);
        return;
      }
      const target = scrollY + glideDistance(t.v);
      if (target <= table.edge) {
        if (Math.abs(scrollY - table.edge) < SAME_PX) {
          const k = targetFrom(scrollY, -1);
          if (k !== null) begin(scrollY, k, now, SNAP_MS);
        } else glide = { y: scrollY, target: table.edge, toEdge: true };
      } else if (Math.abs(target - scrollY) >= SAME_PX)
        glide = { y: scrollY, target, toEdge: false };
    },
    frame(scrollY, now) {
      const dt = lastFrame === null ? FRAME_MS : Math.max(0, now - lastFrame);
      lastFrame = now;
      if (!table)
        return {
          scrollTo: null,
          target: null,
          animating: false,
          idle: true,
          zone: 'free',
        };
      if (touch && touch.free && !touch.ignored) {
        touch.v = touch.follow - touch.prevFollow;
        touch.prevFollow = touch.follow;
      }
      if (move) {
        const m = move;
        const to = ext[m.k] ?? m.from;
        const t = (now - m.t0) / m.ms;
        if (t >= 1) {
          move = null;
          seenY = to;
          changedAt = now;
          return {
            scrollTo: to,
            target: m.k,
            animating: false,
            idle: true,
            zone: zoneOf(to),
          };
        }
        const y = m.from + (to - m.from) * easeOutCubic(t);
        return {
          scrollTo: y,
          target: m.k,
          animating: true,
          idle: false,
          zone: zoneOf(y),
        };
      }
      if (glide) {
        const g = glide;
        g.y += (g.target - g.y) * (1 - Math.exp((-GLIDE_LERP * dt) / FRAME_MS));
        if (Math.abs(g.target - g.y) < SAME_PX) {
          g.y = g.target;
          glide = null;
          if (g.toEdge) {
            const k = targetFrom(g.y, -1);
            if (k !== null) begin(g.y, k, now, SNAP_MS);
          }
        }
        return {
          scrollTo: g.y,
          target: null,
          animating: glide !== null || move !== null,
          idle: glide === null && move === null,
          zone: zoneOf(g.y),
        };
      }
      const zone = zoneOf(scrollY);
      if (touch || seenY === null || seenY !== scrollY) {
        seenY = scrollY;
        changedAt = now;
      }
      if (zone === 'free')
        return {
          scrollTo: null,
          target: null,
          animating: false,
          idle: !touch,
          zone,
        };
      const k = nearest(scrollY);
      const off = Math.abs(scrollY - table.stops[k]!) > SAME_PX;
      if (
        off &&
        !touch &&
        now - changedAt >= SNAP_QUIET_MS &&
        begin(scrollY, k, now, SNAP_MS)
      )
        return {
          scrollTo: null,
          target: k,
          animating: true,
          idle: false,
          zone,
        };
      return {
        scrollTo: null,
        target: k,
        animating: false,
        idle: !off && !touch,
        zone,
      };
    },
    busy: () => move !== null,
  };
}
