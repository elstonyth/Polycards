/**
 * Pack stage: the endless pick in the tilted lineup (full-flow plan 2.4,
 * work package 5). Pure: no DOM, no clock (the caller passes the time and
 * the pointer's x, and writes the track it gets back to the row).
 *
 * - A sideways drag moves an unbounded line position at one pack per
 *   100 px on every size, so the row never has an end.
 * - On release the position gets 8 times the last frame's movement (read
 *   per 60 Hz frame, so the frame rate cannot change it), the target rounds
 *   to the nearest pack, and the position eases there at 10 per second.
 *   The line always comes to rest on a pack.
 * - Keys and the sideways wheel step one pack (one per wheel gesture; the
 *   wheel is swallowed while the line eases).
 * - The track handed to the row is the position kept inside the row:
 *   [-0.5, n - 0.5); the chosen pack is the target modulo n. The row's pose
 *   repeats every n packs, so the wrap is never seen.
 */
import { WHEEL_GAP_MS, WHEEL_MIN_DELTA } from './stage-pager';

/** Drag factor: one pack per 100 px, phone and desktop [code l.882; measured D §E, P §E]. */
export const LINE_PX_PER_PACK = 100;
/** Release: the last frame's movement times 8 [code l.1146-1156]. */
export const LINE_FLING = 8;
/** The settle: a lerp of 10 per second [code l.1155, l.1314-1323]. */
export const LINE_LERP_PER_S = 10;
/** The line counts as at rest this close to its target. */
const SETTLE = 1e-3;
const FRAME_MS = 1000 / 60;

export type FlowLineFrame = {
  /** The unbounded line position, in packs. */
  pos: number;
  /** The position kept inside the row, [-0.5, n - 0.5): the row's track. */
  track: number;
  /** The chosen pack: the target (the nearest pack while held), modulo n. */
  index: number;
  /** Held, or easing to its target. */
  moving: boolean;
  held: boolean;
};

export interface FlowLine {
  /**
   * The row's length and resting track; ignored while the line moves, and
   * when it names the pack the line rests on (the position stays unbounded).
   */
  sync(track: number, count: number): void;
  /** A finger or the mouse lands at x. */
  grab(x: number, now: number): void;
  drag(x: number, now: number): void;
  /** Let go; `fling` false (a cancelled touch): no fling. */
  release(now: number, fling?: boolean): void;
  /** One pack that way (keys). */
  step(dir: 1 | -1): void;
  /** A sideways wheel delta (px); true: consumed. One step per gesture. */
  wheel(d: number, now: number): boolean;
  frame(now: number): FlowLineFrame;
  pos(): number;
  index(): number;
  moving(): boolean;
  held(): boolean;
}

const mod = (a: number, n: number) => ((a % n) + n) % n;

export function createFlowLine(
  o: { canPick?: (index: number) => boolean } = {},
): FlowLine {
  let n = 1;
  let pos = 0;
  let target = 0;
  let held = false;
  let x0 = 0;
  let from = 0;
  /** Where the line stood when it was grabbed (the way it went, for a skip). */
  let grabbedAt = 0;
  let easing = false;
  let lastFrame: number | null = null;
  let prevPos = 0;
  /** The last frame's movement, packs per 60 Hz frame. */
  let v = 0;
  let quiet = false;
  let lastWheel = Number.NEGATIVE_INFINITY;
  let lastAbs = 0;

  /** The first pack that can be picked from k, going `dir`. */
  const pickable = (k: number, dir: number): number => {
    if (!o.canPick || n <= 1) return k;
    const d = dir < 0 ? -1 : 1;
    for (let j = 0; j < n; j++) {
      const c = k + d * j;
      if (o.canPick(mod(c, n))) return c;
    }
    return k;
  };
  const ref = () => (held ? Math.round(pos) : target);
  const out = (): FlowLineFrame => {
    // the track is kept inside the row by the nearest pack (while easing
    // toward a target across the wrap as well): [-0.5, n - 0.5)
    const base = n * Math.floor(Math.round(pos) / n);
    return {
      pos,
      track: pos - base + 0,
      index: mod(ref(), n),
      moving: held || easing,
      held,
    };
  };
  const aim = (t: number, dir: number) => {
    target = pickable(t, dir);
    easing = Math.abs(target - pos) >= SETTLE;
    if (!easing) pos = target;
  };

  const line: FlowLine = {
    sync(track, count) {
      if (held || easing) return;
      const c = Math.max(1, Math.floor(count));
      const k = Math.round(track);
      // the row as the line left it: the position stays unbounded
      if (c === n && mod(k, n) === mod(target, n)) return;
      n = c;
      pos = target = k;
      prevPos = pos;
    },
    grab(x, now) {
      void now;
      held = true;
      easing = false;
      x0 = x;
      from = pos;
      grabbedAt = pos;
      prevPos = pos;
      v = 0;
    },
    drag(x) {
      if (!held) return;
      pos = n <= 1 ? from : from - (x - x0) / LINE_PX_PER_PACK;
    },
    release(now, fling = true) {
      void now;
      if (!held) return;
      held = false;
      const t = Math.round(pos + (fling && n > 1 ? LINE_FLING * v : 0));
      aim(t, Math.sign(t - grabbedAt) || Math.sign(v) || 1);
      v = 0;
    },
    step(dir) {
      if (held) return;
      if (n <= 1) return;
      aim(target + dir, dir);
    },
    wheel(d, now) {
      const abs = Math.abs(d);
      const gap = now - lastWheel;
      const rise = abs > lastAbs;
      lastWheel = now;
      lastAbs = abs;
      // swallowed while the line eases (a gesture's rising start included)
      if (easing) {
        quiet = true;
        return true;
      }
      if (quiet) {
        if (gap < WHEEL_GAP_MS && !rise) return true;
        quiet = false;
      }
      if (abs < WHEEL_MIN_DELTA || held) return true;
      line.step(d > 0 ? 1 : -1);
      quiet = true;
      return true;
    },
    frame(now) {
      const dt = lastFrame === null ? 0 : Math.max(0, now - lastFrame);
      if (held) {
        if (dt > 0) v = ((pos - prevPos) * FRAME_MS) / dt;
        prevPos = pos;
        lastFrame = now;
        return out();
      }
      if (easing) {
        pos += (target - pos) * (1 - Math.exp((-LINE_LERP_PER_S * dt) / 1000));
        if (Math.abs(target - pos) < SETTLE) {
          pos = target;
          easing = false;
        }
      }
      prevPos = pos;
      // still: the next move starts its clock afresh (the loop may sleep)
      lastFrame = easing ? now : null;
      return out();
    },
    pos: () => pos,
    index: () => mod(ref(), n),
    moving: () => held || easing,
    held: () => held,
  };
  return line;
}
