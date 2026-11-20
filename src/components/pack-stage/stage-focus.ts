/**
 * Pack stage, step 2: focus and turn maths (plan-step2.md sections 1, 2 and
 * 8). Pure: no DOM, no three.js, no clock, no React.
 *
 * One timeline: `focus` (f) is 0 at the carousel, 1 at the back stop, then
 * one unit per chapter stop up to N. 0..1 is a timed 700 ms tween on the
 * SPRING curve (the caller eases it; the pose is linear in f there); 1..N
 * follows scroll through `focusTarget` and a damped follow, and `focusDwell`
 * holds 20% of each unit still at both ends. `turn` (0 front, 1 back) is a
 * separate TIMED tween; `turnFor` picks its target with hysteresis, so a
 * pack never rests inside the Silver / Platinum glare band.
 */
import type { StageLayout } from './contract';
import type {
  FocusCtx,
  PoseBlock,
  StageStop,
  StageStopKind,
} from './contract-step2';
import { SPIN_LOCK, dampedFollow, smoothstep } from './stage-pose-step2';

const DEG = Math.PI / 180;

/** Focus tween, carousel to the back stop (section 1). */
export const FOCUS_MS = 700;
/** Turn tween, front to back, ease-in-out (section 1). */
export const TURN_MS = 650;
/** Return to the row (turn and focus together, SPRING; section 1 / 10.11). */
export const RETURN_MS = 650;
/** Chapter content fade before the return's scroll jump (10.11). */
export const LEAVE_FADE_MS = 250;
/** No back uploaded by then: the pack stays on its front for this focus (section 4). */
export const BACK_WAIT_MS = 1200;
/** Turn hysteresis in focus units (section 2). */
export const TURN_HYSTERESIS = 0.08;
/** Neighbours are gone by this focus value (section 1). */
export const NEIGHBOUR_FADE_END = 0.6;
/** Focus scroll follow time constant (section 2). */
export const FOCUS_FOLLOW_MS = 90;
/** In focus rotX is clamped to at most +5 degrees (section 2; positive = top away). */
export const FOCUS_PITCH_MAX = 5 * DEG;
/**
 * At rest on either face the extra yaw (pointer lean, idle sway, beats) stays
 * within this, so a back at rest is 175..185 degrees: 10 degrees clear of the
 * 155..165 band (decision 9c) and outside the 150..170 test band.
 */
export const FOCUS_REST_YAW_MAX = 5 * DEG;
/** Desktop's timed yaw beat per tier stop, by tier order (section 1). */
export const DESKTOP_YAW_BEATS = [-6 * DEG, 0, 6 * DEG] as const;
/** Sold out: dim eases from 0.4 to this in focus, so the back stays legible. */
export const FOCUS_SOLD_OUT_DIM = 0.75;

/** Where the focused pack goes, as fractions of the panel (section 1 table). */
export const FOCUS_PHONE = Object.freeze({
  /** Back stop: panel centre (a touch high: the buyback pill sits under it). */
  back: { x: 0.5, y: 0.47, scale: 1.15 },
  /** Chapter stops: the thumbnail docked top-left in the mini header. */
  dock: { x: 0.115, y: 0.095, scale: 0.3 },
});
export const FOCUS_DESKTOP = Object.freeze({
  /** The left column, about 30% of the width; stays pinned there. */
  back: { x: 0.3, y: 0.5, scale: 1.1 },
  dock: { x: 0.3, y: 0.5, scale: 1.1 },
});

/** Neighbours slide out by this fraction of the host width, sink and set back. */
const NEIGHBOUR_SLIDE_FX = 0.6;
const NEIGHBOUR_SINK_ART = 0.25;
const NEIGHBOUR_BACK_ART = 0.2;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** The focus pose block: `PoseBlock` plus the panel-fraction offsets. */
export type FocusPoseBlock = PoseBlock & { fx: number; fy: number };

const ONE_BACK_STOP: readonly StageStop[] = [{ y: 0, kind: 'back' }];

function stopsOrDefault(stops: readonly StageStop[] | null | undefined) {
  return stops && stops.length > 0 ? stops : ONE_BACK_STOP;
}

/** Highest focus value (N) for these stops. */
export function focusMax(stops: readonly StageStop[] | null): number {
  return stopsOrDefault(stops).length;
}

/**
 * Scroll position (document px, any origin the stops share) to the focus
 * target: 1 + piecewise linear over the stop positions, clamped to [1, N].
 * Negative scroll is clamped to 0 (iOS rubber band).
 */
export function focusTarget(
  y: number,
  stops: readonly StageStop[] | null,
): number {
  const list = stopsOrDefault(stops);
  const yy = Math.max(0, y);
  const first = list[0];
  if (!first || yy <= first.y) return 1;
  for (let k = 0; k + 1 < list.length; k++) {
    const a = list[k];
    const b = list[k + 1];
    if (!a || !b) break;
    if (yy <= b.y) {
      const span = b.y - a.y;
      return 1 + k + (span > 0 ? (yy - a.y) / span : 1);
    }
  }
  return list.length;
}

/**
 * The dwell easing (section 2): within each unit of 1..N, 20% at each end is
 * still. f <= 1 (the timed focus tween) passes through unchanged.
 */
export function focusDwell(f: number): number {
  if (f <= 1) return Math.max(0, f);
  const base = Math.floor(f);
  const t = f - base;
  return base + smoothstep(0, 1, (t - 0.2) / 0.6);
}

/** Critically damped follow of the focus scroll target (tau 90 ms). */
export function followFocus(
  current: number,
  target: number,
  dtMs: number,
  tauMs = FOCUS_FOLLOW_MS,
): number {
  return dampedFollow(current, target, dtMs, tauMs);
}

/** The stop kind at focus value f (nearest stop; f < 1 counts as the first stop). */
export function stopKindAt(
  f: number,
  stops: readonly StageStop[] | null,
): StageStopKind {
  const list = stopsOrDefault(stops);
  const j = Math.min(list.length - 1, Math.max(0, Math.round(f) - 1));
  return list[j]?.kind ?? 'back';
}

function wantsBack(kind: StageStopKind, desktop: boolean): boolean {
  return kind === 'back' || (desktop && kind === 'odds');
}

/**
 * The turn target (section 2): phone shows the back only at the 'back' stop,
 * desktop at 'back' and at 'odds'. Hysteresis +-0.08: near a boundary the
 * previous target is kept. Always 0 when `canTurn` is false (capsules, packs
 * with no pull odds) or the back is not uploaded, and while leaving.
 */
export function turnFor(
  f: number,
  stops: readonly StageStop[] | null,
  desktop: boolean,
  prev: 0 | 1,
  o: { canTurn: boolean; backReady: boolean; leaving?: boolean },
): 0 | 1 {
  if (!o.canTurn || !o.backReady || o.leaving || f <= 0) return 0;
  const a = wantsBack(stopKindAt(f - TURN_HYSTERESIS, stops), desktop);
  const b = wantsBack(stopKindAt(f + TURN_HYSTERESIS, stops), desktop);
  if (a !== b) return prev;
  return a ? 1 : 0;
}

/**
 * Desktop's yaw beat target (section 1): -6, 0, +6 degrees by the order of
 * the tier stop the visitor is on (timed by the caller, never scrubbed); 0
 * elsewhere and on phones. Same hysteresis as `turnFor`.
 */
export function yawBeatFor(
  f: number,
  stops: readonly StageStop[] | null,
  desktop: boolean,
  prev: number,
): number {
  if (!desktop || f < 1) return 0;
  const at = (x: number) => {
    const list = stopsOrDefault(stops);
    const j = Math.min(list.length - 1, Math.max(0, Math.round(x) - 1));
    if (list[j]?.kind !== 'tier') return 0;
    let order = 0;
    for (let k = 0; k < j; k++) if (list[k]?.kind === 'tier') order++;
    return (
      DESKTOP_YAW_BEATS[Math.min(order, DESKTOP_YAW_BEATS.length - 1)] ?? 0
    );
  };
  const a = at(f - TURN_HYSTERESIS);
  const b = at(f + TURN_HYSTERESIS);
  return a === b ? a : prev;
}

/** Spin and focus are exclusive (10.4): focus may start only below 0.02, target and value. */
export function canStartFocus(spin: number, spinTarget: number): boolean {
  return spin < SPIN_LOCK && spinTarget < SPIN_LOCK;
}

/** While focus > 0 the spin is held at 0 (10.4). */
export function spinWhileFocused(focus: number, spin: number): number {
  return focus > 0 ? 0 : spin;
}

/** A neighbour's fade-out over f 0..0.6 (section 1); the focused pack stays 1. */
export function focusOpacity(f: number, isFocused: boolean): number {
  if (isFocused) return 1;
  return 1 - smoothstep(0, NEIGHBOUR_FADE_END, f);
}

type Key = { x: number; y: number; scale: number };

function keyAt(k: number, desktop: boolean): Key {
  const t = desktop ? FOCUS_DESKTOP : FOCUS_PHONE;
  return k <= 1 ? t.back : t.dock;
}

/**
 * The focused pack's pose block at focus value f, without the turn. Linear
 * from the rest block over f 0..1 (the animator eases f); between chapter
 * stops it moves with the dwell easing.
 */
function focusedBlock(
  rest: Readonly<PoseBlock>,
  f: number,
  d: number,
  l: Readonly<StageLayout>,
  desktop: boolean,
  ctx: Readonly<FocusCtx>,
  soldOut: boolean,
): FocusPoseBlock {
  const n = focusMax(ctx.stops);
  const keyPose = (k: number) => {
    const key = keyAt(k, desktop);
    return {
      fx: key.x - 0.5,
      fy: key.y - ctx.anchorY,
      scale: key.scale,
    };
  };
  // the pose the f in [0, 1] segment leads to: stop 1, or (returning) the
  // pose the visitor left from
  const from =
    ctx.leaveFrom !== undefined ? Math.min(n, Math.max(1, ctx.leaveFrom)) : 1;
  const at = (fv: number) => {
    const e = focusDwell(Math.min(n, Math.max(1, fv)));
    const k0 = Math.floor(e);
    const t = e - k0;
    const a = keyPose(k0);
    const b = keyPose(Math.min(n, k0 + 1));
    return {
      fx: lerp(a.fx, b.fx, t),
      fy: lerp(a.fy, b.fy, t),
      scale: lerp(a.scale, b.scale, t),
    };
  };
  const target = at(f > 1 ? f : from);
  const u = clamp01(f); // 1 for every chapter stop
  const dim = soldOut ? FOCUS_SOLD_OUT_DIM : 1;
  return {
    // centre the pack on its slot if the track was not exactly on it
    dx: lerp(rest.dx, -d * l.step, u),
    dy: lerp(rest.dy, 0, u),
    z: lerp(rest.z, 0, u),
    rotX: lerp(rest.rotX, 0, u),
    rotY: lerp(rest.rotY, 0, u),
    rotZ: lerp(rest.rotZ, 0, u),
    scale: lerp(rest.scale, target.scale, u),
    dim: lerp(rest.dim, dim, u),
    fx: target.fx * u,
    fy: target.fy * u,
  };
}

/**
 * Focus pose for pack i (sections 1 and 2). `rest` is the rest-carousel
 * block (the spin is held at 0 in focus). `turn` adds pi * turn to the
 * focused pack's yaw; `ctx.yawBeat` adds desktop's timed beat. Neighbours
 * slide off sideways and sink. f <= 0 returns `rest` with zero offsets.
 */
export function focusPose(
  rest: Readonly<PoseBlock>,
  focus: number,
  turn: number,
  i: number,
  track: number,
  l: Readonly<StageLayout>,
  desktop: boolean,
  soldOut: boolean,
  ctx: Readonly<FocusCtx>,
): FocusPoseBlock {
  const f = Math.max(0, focus);
  if (!(f > 0)) return { ...rest, fx: 0, fy: 0 };
  const d = i - track;
  if (i === ctx.index) {
    const b = focusedBlock(rest, f, d, l, desktop, ctx, soldOut);
    b.rotY +=
      Math.PI * clamp01(turn) + (ctx.yawBeat ?? 0) * (1 - clamp01(turn));
    b.rotX = Math.min(b.rotX, FOCUS_PITCH_MAX);
    return b;
  }
  const side = i > ctx.index ? 1 : -1;
  const e = clamp01(f);
  return {
    ...rest,
    dy: rest.dy + NEIGHBOUR_SINK_ART * l.artH * e,
    z: rest.z - NEIGHBOUR_BACK_ART * l.artH * e,
    fx: side * NEIGHBOUR_SLIDE_FX * e,
    fy: 0,
  };
}

/**
 * Clamps the extra yaw (pointer lean, idle sway) the caller adds on top of a
 * focused pack's pose, so it rests at most 5 degrees off square on either face.
 */
export function clampFocusExtraYaw(extra: number, focus: number): number {
  if (!(focus > 0)) return extra;
  const m = FOCUS_REST_YAW_MAX;
  return extra > m ? m : extra < -m ? -m : extra;
}

/** ease-in-out used for the timed turn: cubic-bezier(0.45, 0, 0.55, 1) (10.11). */
export const TURN_BEZIER = [0.45, 0, 0.55, 1] as const;
