/**
 * Pure timing for the brand loader ("cut reveal"). Everything the loader draws is a
 * function of one number, the reveal time in ms, so a pinned `?t=` frame and a
 * frame-stepped capture show exactly what a live run shows at that moment.
 *
 * Reveal (ms from mount):
 * - Mark: each stroke draws 0 -> 1 over STROKE_MS on an ease-in-out curve, strokes
 *   STROKE_STAGGER_MS apart.
 * - Wordmark: from LETTERS_START_MS each letter rises from below a cut line on a
 *   critically-near spring (about 3% overshoot), LETTER_STAGGER_MS apart.
 * - REVEAL_MS: everything is at rest; offsets snap to exactly 0 so edges are crisp.
 */

export const STROKE_MS = 700;
export const STROKE_STAGGER_MS = 90;
export const LETTERS_START_MS = 450;
export const LETTER_STAGGER_MS = 45;
export const REVEAL_MS = 1600;

/** Spring for the letters (mass 1). damping / (2 * sqrt(stiffness)) = 0.74. */
export const LETTER_SPRING = { stiffness: 260, damping: 24 } as const;

/** cubic-bezier(.65, 0, .35, 1): a firm ease-in-out for the strokes. */
export const STROKE_EASE = [0.65, 0, 0.35, 1] as const;

export interface LoaderTimings {
  /** Earliest the loader may start leaving, in ms from mount. */
  minMs: number;
  /** Latest the loader leaves even if `ready` never comes, in ms from mount. */
  maxMs: number;
  /** Exit fade length in ms. */
  exitMs: number;
}

export const DEFAULT_TIMINGS: LoaderTimings = {
  minMs: REVEAL_MS,
  maxMs: 6000,
  exitMs: 400,
};

export type LoaderPhase = 'revealing' | 'holding' | 'exiting' | 'done';

/**
 * When the loader starts leaving, in ms from mount: once ready (and the minimum has
 * passed), or at the maximum wait, whichever is first. `readyAtMs` is when `ready`
 * first turned true, or null if it has not.
 */
export function leaveAtMs(
  readyAtMs: number | null,
  timings: LoaderTimings,
): number {
  const wanted =
    readyAtMs === null ? Infinity : Math.max(timings.minMs, readyAtMs);
  return Math.min(timings.maxMs, wanted);
}

/** The loader's phase at `elapsedMs` after mount. */
export function loaderPhase(
  elapsedMs: number,
  readyAtMs: number | null,
  timings: LoaderTimings = DEFAULT_TIMINGS,
): LoaderPhase {
  const leaveAt = leaveAtMs(readyAtMs, timings);
  if (elapsedMs >= leaveAt + timings.exitMs) return 'done';
  if (elapsedMs >= leaveAt) return 'exiting';
  if (elapsedMs < REVEAL_MS) return 'revealing';
  return 'holding';
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** CSS cubic-bezier(x1, y1, x2, y2) as a function of progress 0..1. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const bez = (t: number, a: number, b: number) =>
    3 * a * t * (1 - t) ** 2 + 3 * b * t * t * (1 - t) + t ** 3;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // Bisection on the x curve (monotonic for x1, x2 in 0..1); 30 steps is sub-1e-9.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (bez(mid, x1, x2) < x) lo = mid;
      else hi = mid;
    }
    return bez((lo + hi) / 2, y1, y2);
  };
}

const strokeEase = cubicBezier(...STROKE_EASE);

/** How much of stroke `index` is drawn (0..1) at reveal time `tMs`. */
export function strokeProgress(index: number, tMs: number): number {
  return strokeEase(clamp01((tMs - index * STROKE_STAGGER_MS) / STROKE_MS));
}

/**
 * Position of a spring released from rest at 0 towards 1, `seconds` after release
 * (closed form, underdamped). Overshoots slightly past 1, then settles.
 */
export function springPosition(
  seconds: number,
  {
    stiffness,
    damping,
  }: { stiffness: number; damping: number } = LETTER_SPRING,
): number {
  if (seconds <= 0) return 0;
  const w0 = Math.sqrt(stiffness);
  const zeta = damping / (2 * w0);
  if (zeta >= 1) {
    // Critically or overdamped: no overshoot (critical form is close enough here).
    return 1 - Math.exp(-w0 * seconds) * (1 + w0 * seconds);
  }
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  const decay = Math.exp(-zeta * w0 * seconds);
  return (
    1 -
    decay *
      (Math.cos(wd * seconds) + ((zeta * w0) / wd) * Math.sin(wd * seconds))
  );
}

/**
 * How far letter `index` still sits below its place, as a fraction of its travel
 * (1 = fully below the cut, 0 = in place, slightly negative = overshoot). Exactly 0
 * from REVEAL_MS on.
 */
export function letterOffset(index: number, tMs: number): number {
  if (tMs >= REVEAL_MS) return 0;
  const start = LETTERS_START_MS + index * LETTER_STAGGER_MS;
  return 1 - springPosition((tMs - start) / 1000);
}

/** Split a path into its subpaths (each starting at an M/m), for staggered strokes. */
export function splitSubpaths(d: string): string[] {
  return d
    .split(/(?=[Mm])/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Vertical extent of a path's points (end points and control points, which bound the
 * curve), for absolute and relative M L H V C S Q T Z. Arcs are not handled.
 */
export function pathYExtent(d: string): { minY: number; maxY: number } {
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) ?? [];
  const arity: Record<string, number> = {
    M: 2,
    L: 2,
    H: 1,
    V: 1,
    C: 6,
    S: 4,
    Q: 4,
    T: 2,
    Z: 0,
  };
  let minY = Infinity;
  let maxY = -Infinity;
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let cmd = 'M';
  let i = 0;
  const seeY = (v: number) => {
    if (v < minY) minY = v;
    if (v > maxY) maxY = v;
  };
  while (i < tokens.length) {
    const token = tokens[i] ?? '';
    const isCommand = /[A-Za-z]/.test(token);
    if (isCommand) {
      cmd = token;
      i++;
    }
    const up = cmd.toUpperCase();
    const rel = cmd !== up;
    const n = arity[up];
    if (n === undefined)
      throw new Error(`pathYExtent: unsupported command ${cmd}`);
    if (n === 0) {
      x = startX;
      y = startY;
      // Numbers straight after Z are malformed; stop rather than loop on them.
      if (!isCommand) break;
      continue;
    }
    const args = tokens.slice(i, i + n).map(Number);
    if (args.length < n) break;
    i += n;
    const arg = (k: number) => args[k] ?? 0;
    if (up === 'H') {
      x = rel ? x + arg(0) : arg(0);
    } else if (up === 'V') {
      y = rel ? y + arg(0) : arg(0);
    } else {
      for (let k = 1; k < n; k += 2) seeY(rel ? y + arg(k) : arg(k));
      x = rel ? x + arg(n - 2) : arg(n - 2);
      y = rel ? y + arg(n - 1) : arg(n - 1);
    }
    seeY(y);
    if (up === 'M') {
      startX = x;
      startY = y;
      cmd = rel ? 'l' : 'L';
    }
  }
  return { minY, maxY };
}
