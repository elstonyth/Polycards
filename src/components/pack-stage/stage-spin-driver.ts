/**
 * Pack stage, step 2: what drives `spin` and the exit (plan-step2.md 10.9 and
 * 10.14, corrected by the Ciao motion sheet of 2026-11-20, sections 9.1-9.3).
 * Pure: no React, no DOM reads, no clock (the caller passes `now` and
 * `scrollY`); the provider feeds it from its listeners and frame loop.
 *
 * Our page has three stops, like Ciao's sections 6, 7 and 8: the pin start
 * (spin 0), the pin end (spin 1, the row formed) and the exit end (the row
 * gone: `exit` 1, 1.25 panels further down).
 *
 * `paged` (DEFAULT: the owner's ruling, Ciao's trigger):
 * - Wheel (all widths): active while the stop nearest the scroll is the pin
 *   start (Ciao: nearest section 0-6). Every wheel event there is consumed;
 *   |deltaY| < 4 is ignored; otherwise one animated scroll to the pin end (or
 *   back to the pin start), 1.5 s ease-out cubic, input locked meanwhile,
 *   reverse wheel ignored, one page per lock. With the pin end nearest, the
 *   wheel is free (native), so the exit is scrubbed by free scrolling and
 *   scrolling back up pages again once the start is nearer (Ciao 9.2).
 * - Touch: at touch start the anchor is the nearest stop; paging is armed at
 *   the pin start and the pin end (Ciao: 0-7, so a swipe at the formed row
 *   pages through the exit). After 2 px the axis locks; vertically every move
 *   is consumed and the page does NOT follow the finger. On release: moved
 *   over 24 px -> one stop in that direction, else back to the anchor; 1.5 s
 *   ease-out cubic; one stop per gesture whatever its length. A touch during
 *   a running page freezes it where it is; its release pages from the stop
 *   nearest that point (Ciao 9.3).
 * - The caller writes `scrollTo` to the window each frame. Ciao lands 10 px
 *   short of each top; we land exactly on the stops (spin exactly 0 or 1, so
 *   the back print queue sees a settled spin).
 * - The spin is the scroll's progress through the pin. With `pagedRemap`
 *   (default, for the full-turn variant) it rides `pagedSpin`; without it
 *   (the `tip` variant, Ciao's own look) it is the progress itself, as Ciao.
 *
 * `free` (`?spin=free`): nothing is consumed; spin and exit follow the scroll
 * with `v += (target - v) * (1 - exp(-dt / 150 ms))`.
 *
 * Outside a page, `paged` follows the scroll with the same follow (scrollbar,
 * keyboard, native wheel past the pin). Reduced motion, or no range (focus,
 * no packs): spin and exit 0, nothing consumed, no scroll writes: pass
 * `reducedMotion: true` and draw step 1.
 */
import { clamp01, dampedFollow } from './stage-pose-step2';

export type SpinDriverMode = 'paged' | 'free';

/** Ciao's paging length for every move we have (motion sheet 9.2 / 9.3). */
export const PAGED_MS = 1500;
/** Free follow (Lenis lerp 0.1, time constant about 0.17 s; 10.9 used 150 ms). */
export const SPIN_FOLLOW_MS = 150;
/** Ciao's phone threshold: a swipe over 24 px pages on release. */
export const TOUCH_PAGE_PX = 24;
/** Ciao locks a touch's axis after this much travel. */
const AXIS_LOCK_PX = 2;
/** Wheel deltas under this are ignored (still consumed while armed). */
const WHEEL_MIN_DELTA = 4;
/** Scroll positions this close to a stop count as on it. */
export const EDGE_PX = 2;
/** "Settled" for the back print queue: |target - spin| at most this (10.5). */
export const SPIN_SETTLED = 0.01;
/** Exit length in panel heights (one Ciao section). */
export const EXIT_PANELS = 1.25;

export type SpinRange = {
  start: number;
  length: number;
  /** The exit's scroll length after the pin (1.25 panels); 0 or absent: none. */
  exit?: number;
};

export type SpinDriverOptions = {
  mode: SpinDriverMode;
  reducedMotion: boolean;
  /** Override for tests and the bench; default `PAGED_MS`. */
  pagedMs?: number;
  /** Override for tests and the bench; default `SPIN_FOLLOW_MS`. */
  followMs?: number;
  /** Paged only: remap the spin through `pagedSpin` (full turn). Default true. */
  pagedRemap?: boolean;
};

export type SpinFrame = {
  /** The spin to draw, 0..1. */
  spin: number;
  /** The exit to draw, 0..1 (the row leaving after the pin). */
  exit: number;
  /** Where the spin is heading. */
  target: number;
  /** Paged only: write this to the window scroll this frame; else null. */
  scrollTo: number | null;
  /** A page is playing (input locked). */
  animating: boolean;
  /** |target - spin| <= 0.01 and no page playing: the back print queue may run. */
  settled: boolean;
  /** The loop may sleep: fully at rest. */
  idle: boolean;
};

export interface SpinDriver {
  readonly mode: SpinDriverMode;
  setRange(r: SpinRange | null): void;
  /** A wheel event. Returns true when consumed (caller: preventDefault). */
  wheel(deltaY: number, scrollY: number, now: number): boolean;
  touchStart(x: number, y: number, scrollY: number, now: number): void;
  /** A touch move. Returns true when consumed (caller: preventDefault). */
  touchMove(x: number, y: number, scrollY: number, now: number): boolean;
  touchEnd(scrollY: number, now: number): void;
  frame(scrollY: number, now: number): SpinFrame;
  /** Forget any page and follow state, e.g. at focus start or a set change. */
  reset(spin?: number): void;
}

/** Ciao's `easeOutCubic`. */
export function easeOutCubic(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

/**
 * Paged mode's page-progress -> spin remap for the FULL-TURN variant (a bench
 * finding, integration-notes.md). If the spin were the eased progress itself,
 * the 1.5 s ease-out would play the turn row's gather (spin 0..0.15) in about
 * 80 ms and spend the last 0.8 s on its hold (0.85..1), where nothing moves.
 * Two knots per direction put the gather end and the hold start where the
 * ease-out leaves them time: down, gather about 200 ms and travel about
 * 0.9 s; up, travel back about 0.8 s and un-gather on the tail. The pose's
 * own easing has zero velocity at both knots. The `tip` variant (Ciao's own
 * row, one power1.inOut over the whole spin) does not need it.
 */
export const PAGED_KNOTS = Object.freeze({
  down: [0.35, 0.98] as const,
  up: [0.1, 0.98] as const,
});
/** spinPose's phase edges (stage-spin.ts GATHER and HOLD), mirrored. */
const KNOT_SPIN = [0.15, 0.85] as const;

export function pagedSpin(p: number, dir: 'down' | 'up'): number {
  const [a, b] = PAGED_KNOTS[dir];
  const [sa, sb] = KNOT_SPIN;
  const x = clamp01(p);
  if (x <= a) return (x / a) * sa;
  if (x <= b) return sa + ((x - a) / (b - a)) * (sb - sa);
  return sb + ((x - b) / (1 - b)) * (1 - sb);
}

/** Inverse of `pagedSpin`. */
export function pagedProgress(s: number, dir: 'down' | 'up'): number {
  const [a, b] = PAGED_KNOTS[dir];
  const [sa, sb] = KNOT_SPIN;
  const x = clamp01(s);
  if (x <= sa) return (x / sa) * a;
  if (x <= sb) return a + ((x - sa) / (sb - sa)) * (b - a);
  return b + ((x - sb) / (1 - sb)) * (1 - b);
}

/** Scroll progress through the pin, 0..1. */
export function spinProgress(scrollY: number, r: SpinRange | null): number {
  if (!r || !(r.length > 0)) return 0;
  return clamp01((scrollY - r.start) / r.length);
}

/** Scroll progress through the exit, 0..1. */
export function exitProgress(scrollY: number, r: SpinRange | null): number {
  if (!r || !(r.exit && r.exit > 0)) return 0;
  return clamp01((scrollY - r.start - r.length) / r.exit);
}

type Page = {
  t0: number;
  fromScroll: number;
  toScroll: number;
  /** Pin page with the remap: remap-space progress at start and end. */
  remap: { fromP: number; toP: number; dir: 'down' | 'up' } | null;
};

type Gesture = {
  x0: number;
  y0: number;
  y: number;
  anchor: number;
  armed: boolean;
  axis: 'x' | 'y' | null;
};

export function createSpinDriver(o: SpinDriverOptions): SpinDriver {
  const pagedMs = o.pagedMs ?? PAGED_MS;
  const followMs = o.followMs ?? SPIN_FOLLOW_MS;
  const remapOn = o.pagedRemap ?? true;
  let range: SpinRange | null = null;
  let spin = 0;
  let exit = 0;
  let lastNow: number | null = null;
  let page: Page | null = null;
  /** Scroll where a touch froze a running page (the caller holds it there). */
  let frozenAt: number | null = null;
  let gesture: Gesture | null = null;

  const off = () => o.reducedMotion || range === null;
  const stops = (): number[] => {
    if (!range) return [];
    const s = [range.start, range.start + range.length];
    if (range.exit && range.exit > 0)
      s.push(range.start + range.length + range.exit);
    return s;
  };
  const nearest = (p: number): number => {
    const s = stops();
    let k = 0;
    for (let j = 1; j < s.length; j++)
      if (Math.abs(p - (s[j] ?? 0)) < Math.abs(p - (s[k] ?? 0))) k = j;
    return k;
  };

  const begin = (fromScroll: number, k: number, now: number) => {
    const s = stops();
    const toScroll = s[Math.max(0, Math.min(s.length - 1, k))];
    if (toScroll === undefined || !range) return;
    if (Math.abs(toScroll - fromScroll) < 0.5) return;
    const end = range.start + range.length;
    const pinPage =
      fromScroll <= end + EDGE_PX &&
      toScroll <= end + EDGE_PX &&
      toScroll >= range.start - EDGE_PX;
    const dir = toScroll > fromScroll ? 'down' : 'up';
    page = {
      t0: now,
      fromScroll,
      toScroll,
      remap:
        pinPage && remapOn
          ? {
              // start from the spin on screen, so a page never jumps it
              fromP: pagedProgress(spin, dir),
              toP: spinProgress(toScroll, range),
              dir,
            }
          : null,
    };
    frozenAt = null;
  };

  return {
    mode: o.mode,
    setRange(r) {
      range =
        r && r.length > 0
          ? { start: r.start, length: r.length, exit: r.exit }
          : null;
      if (!range) {
        page = null;
        gesture = null;
        frozenAt = null;
        spin = 0;
        exit = 0;
      }
    },
    wheel(deltaY, scrollY, now) {
      if (o.mode !== 'paged' || off()) return false;
      if (page) return true; // locked: swallowed, reverse ignored
      if (nearest(scrollY) !== 0) return false; // the formed row and below: free
      if (Math.abs(deltaY) < WHEEL_MIN_DELTA) return true;
      if (deltaY > 0) {
        begin(scrollY, 1, now);
        return true;
      }
      // up at the pin start: nothing above to page to; the page is native
      if (range && scrollY <= range.start + EDGE_PX) return false;
      begin(scrollY, 0, now);
      return true;
    },
    touchStart(x, y, scrollY) {
      if (o.mode !== 'paged' || off()) {
        gesture = null;
        return;
      }
      let p = scrollY;
      if (page) {
        // a touch during a page freezes it where it is
        p = frozenAt = scrollY;
        page = null;
      }
      const anchor = nearest(p);
      gesture = { x0: x, y0: y, y, anchor, armed: anchor <= 1, axis: null };
    },
    touchMove(x, y) {
      const g = gesture;
      if (!g || !g.armed) return false;
      g.y = y;
      if (g.axis === null) {
        const dx = Math.abs(x - g.x0);
        const dy = Math.abs(y - g.y0);
        if (Math.max(dx, dy) < AXIS_LOCK_PX) return true;
        g.axis = dx > dy ? 'x' : 'y';
      }
      // vertical: the page does not follow the finger at all
      return g.axis === 'y';
    },
    touchEnd(scrollY, now) {
      const g = gesture;
      gesture = null;
      if (!g || !g.armed) {
        frozenAt = null;
        return;
      }
      if (g.axis === 'x') {
        frozenAt = null;
        return;
      }
      const moved = g.y0 - g.y; // > 0: finger up, page down
      const p = frozenAt ?? scrollY;
      const k =
        Math.abs(moved) > TOUCH_PAGE_PX
          ? g.anchor + Math.sign(moved)
          : g.anchor;
      begin(p, k, now);
      frozenAt = null;
    },
    frame(scrollY, now) {
      const dt = lastNow === null ? 0 : now - lastNow;
      lastNow = now;
      if (off()) {
        spin = 0;
        exit = 0;
        page = null;
        return {
          spin: 0,
          exit: 0,
          target: 0,
          scrollTo: null,
          animating: false,
          settled: true,
          idle: true,
        };
      }
      if (frozenAt !== null) {
        return {
          spin,
          exit,
          target: spin,
          scrollTo: frozenAt,
          animating: false,
          settled: false,
          idle: false,
        };
      }
      if (page) {
        const t = (now - page.t0) / pagedMs;
        const e = easeOutCubic(t);
        const scrollTo =
          page.fromScroll + (page.toScroll - page.fromScroll) * e;
        const pr = page.remap;
        spin = pr
          ? pagedSpin(pr.fromP + (pr.toP - pr.fromP) * e, pr.dir)
          : spinProgress(scrollTo, range);
        exit = exitProgress(scrollTo, range);
        const target = spinProgress(page.toScroll, range);
        if (t >= 1) {
          spin = target;
          exit = exitProgress(page.toScroll, range);
          page = null;
          return {
            spin,
            exit,
            target,
            scrollTo,
            animating: false,
            settled: true,
            idle: true,
          };
        }
        return {
          spin,
          exit,
          target,
          scrollTo,
          animating: true,
          settled: false,
          idle: false,
        };
      }
      const target = spinProgress(scrollY, range);
      const exitTarget = exitProgress(scrollY, range);
      spin = dampedFollow(spin, target, dt, followMs);
      exit = dampedFollow(exit, exitTarget, dt, followMs);
      return {
        spin,
        exit,
        target,
        scrollTo: null,
        animating: false,
        settled: Math.abs(target - spin) <= SPIN_SETTLED,
        idle: spin === target && exit === exitTarget,
      };
    },
    reset(next = 0) {
      page = null;
      gesture = null;
      frozenAt = null;
      spin = clamp01(next);
      exit = 0;
    },
  };
}
