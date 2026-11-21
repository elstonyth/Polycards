/**
 * Pack stage pose function (plan section 1 and 4). Pure: no DOM, no three.js,
 * no clock. The same `StageState` always gives the same `Pose`, so the CSS
 * tiles, the WebGL runtime and (step 2) a scroll position can all seek it.
 *
 * Pose units and axes are CSS (the layout is measured in host CSS px):
 * - `dx`, `dy`: offset in host CSS px from the tile's linear slot
 *   `(cx + (i - track) * step, cy)`. +x right, +y DOWN.
 * - `z`: CSS px along the view axis, +z toward the viewer (negative = set back).
 * - `rotX`, `rotY`: radians, exactly CSS `rotateX()` / `rotateY()`:
 *   `rotX > 0` tips the top edge away (tilted back); `rotY > 0` turns the face
 *   toward +x (right). Apply as `rotateY` then `rotateX` around the art centre.
 *   three.js (y up): `position = (dx*k, -dy*k, z*k)`, `rotation.x = -rotX`,
 *   `rotation.y = rotY`.
 * - Linear in the layout: `dx` scales with `step`; `dy` and `z` with `artH`;
 *   `cx` and `cy` are not read. So `poseAt(s, i, {cx:0, cy:0, step:1, artH:1})`
 *   gives the pose in steps / art heights, and CSS can multiply it back.
 * - `scale`: model scale on top of the measured art size (1 = centred pack).
 * - `dim`: brightness multiplier (1 = full). Sold out multiplies by 0.4.
 *
 * State conventions (the provider drives these; step 2 may drive any of them):
 * - `intro` in [0,1] is LINEAR time through the float-in (`INTRO_TOTAL_MS`);
 *   each slot applies its own stagger and easing here.
 * - `swap` in [0,1]: 0 = in place, 1 = sunk out of the stage. Displacement is
 *   linear in `swap`; the ANIMATOR eases it (provider: old category 0 -> 1 in
 *   250 ms ease-in, new category 1 -> 0 in 450 ms on the SPRING curve).
 * - `pointerX`, `pointerY` in [-1,1] relative to the host centre (+y down).
 * - `idle`: idle clock in seconds (0 = no idle motion). Bob and sway are both
 *   zero at every multiple of `IDLE_REST_PERIOD_S`; the provider eases the
 *   clock to the next one to come to rest.
 * - `spin`, `exit` (step 2): the scroll spin's progress and its exit; the row
 *   itself comes from the injected `ctx.spin.spinPose` (lazily loaded).
 * - `focus`, `turn` (step 2): read only through the injected focus term.
 *
 * Composition (plan-step2.md 10.9): the rest-carousel block -> the spin term
 * (only with `ctx.spin.spinPose`) -> the focus term (only with
 * `ctx.focusTerm`) -> the float-in, swap, pointer-lean and idle terms added on
 * top. With no spin, no exit and no focus `poseAt` is step 1's pose exactly.
 */
import { cubicBezier } from '@/components/loader/loader-timeline';

import type { ComposeCtx, Pose, StageLayout, StageState } from './contract';

/** Below this the spin counts as stopped: controls back, focus allowed (10.3, 10.4). */
export const SPIN_LOCK = 0.02;

/** soft.tsx SPRING curve. */
export const STAGE_SPRING_BEZIER = [0.32, 0.72, 0, 1] as const;

export const INTRO_TOTAL_MS = 1100;
export const INTRO_SLOT_MS = 700;
export const INTRO_STAGGER_MS = 90;
/** Names and prices fade in this long after their pack starts. */
export const INTRO_LABEL_DELAY_MS = 120;
export const SWAP_SINK_MS = 250;
export const SWAP_RISE_MS = 450;
/** Last stagger step that still finishes inside `INTRO_TOTAL_MS`. */
const INTRO_MAX_STAGGER_SLOT = Math.floor(
  (INTRO_TOTAL_MS - INTRO_SLOT_MS) / INTRO_STAGGER_MS,
);

const DEG = Math.PI / 180;
export const POINTER_LEAN_RAD = 5 * DEG;
export const IDLE_SWAY_RAD = 2.5 * DEG;
export const IDLE_PERIOD_S = 6;
export const IDLE_REST_PERIOD_S = 3;
/** About 0.015 world units of bob, expressed against the art height. */
export const IDLE_BOB_ART = 0.006;

const FLOAT_TILT_RAD = 0.5;
const FLOAT_TURN_RAD = 0.6;
/**
 * Float-in starts this far below its slot, in art heights: the plan's "about
 * 35% of the stage height" is 0.71 art heights on a phone (716 / 352 px) and
 * 0.54 on desktop (860 / 560 px). Kept in art heights so the pose is linear
 * in the layout (see `poseAt`).
 */
const FLOAT_DROP_ART = 0.6;
const FLOAT_BACK_ART = 0.6;
const SWAP_BACK_ART = 0.2;
const DEPTH_PER_SLOT_ART = 0.18;
const SOLD_OUT_DIM = 0.4;

/**
 * Rest pose by distance from the centre, |d| = 0, 1, 2, 3: offset in steps
 * (extrapolated beyond 3), scale, yaw (radians, magnitude), dim (clamped beyond 3).
 */
const OFFSET_STEPS = [0, 1, 560 / 330, 2.3] as const;
const SCALE = [1, 0.72, 0.55, 0.45] as const;
const YAW = [0, 20 * DEG, 28 * DEG, 32 * DEG] as const;
const DIM_DESKTOP = [1, 1, 0.6, 0.35] as const;
const DIM_PHONE = [1, 1, 1, 1] as const;
const OFFSET_LAST = OFFSET_STEPS.length - 1;
const OFFSET_TAIL_SLOPE = OFFSET_STEPS[3] - OFFSET_STEPS[2];

/**
 * How far from the centre a pack is still drawn: phone +-1, desktop +-2.
 * `Pose` carries no opacity, so CSS tiles and the runtime share this rule.
 */
export const STAGE_REACH = { phone: 1, desktop: 2 } as const;

/** Tile opacity at signed distance `d`: 1 within reach, fading to 0 one slot beyond. */
export function slotOpacity(d: number, desktop: boolean): number {
  const reach = desktop ? STAGE_REACH.desktop : STAGE_REACH.phone;
  return clamp01(reach + 1 - Math.abs(d));
}

/**
 * A pack's whole opacity: its reach fade (the spin row's, while it runs),
 * times the category switch's fade (sinking packs fade out, rising ones in, on
 * the SPRING curve of `swap`). (The arrival's float-in fade, `introOpacity`,
 * and the focus fade are added by `stage-compose.ts`, wired with focus.) And
 * the focus neighbour fade. The canvas draws with this; the CSS tiles
 * (`tileVars`) use the same formula.
 */
export function stageOpacity(
  s: StageState,
  i: number,
  desktop: boolean,
  count = 0,
  ctx: Readonly<ComposeCtx> = {},
): number {
  const d = i - s.track;
  const reach =
    ctx.spinOpacity && (s.spin > 0 || s.exit > 0) && !(s.focus > 0)
      ? ctx.spinOpacity(s, i, desktop, count)
      : slotOpacity(d, desktop);
  return reach * (1 - stageSpring(clamp01(s.swap)));
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function lerpTable(table: readonly number[], a: number): number {
  const last = table.length - 1;
  if (a >= last) return table[last] ?? 0;
  const lo = Math.floor(a);
  const f = a - lo;
  const v0 = table[lo] ?? 0;
  const v1 = table[lo + 1] ?? v0;
  return v0 + (v1 - v0) * f;
}

/** SPRING easing, 0..1 -> 0..1 (exactly 0 and 1 at the ends). */
export const stageSpring = cubicBezier(...STAGE_SPRING_BEZIER);

/** Stagger slot of a pack `d` slots from the centre (0 = first). */
function staggerSlot(d: number): number {
  return Math.min(Math.round(Math.abs(d)), INTRO_MAX_STAGGER_SLOT);
}

/** Linear float-in progress of the pack at signed distance `d`, in [0,1]. */
export function slotIntroLinear(intro: number, d: number): number {
  const t = clamp01(intro) * INTRO_TOTAL_MS;
  return clamp01((t - staggerSlot(d) * INTRO_STAGGER_MS) / INTRO_SLOT_MS);
}

/** Eased float-in progress of the pack at signed distance `d`, in [0,1]. */
export function slotIntro(intro: number, d: number): number {
  return stageSpring(slotIntroLinear(intro, d));
}

/**
 * Label (name, price) fade-in progress, in [0,1]: starts 120 ms after its pack
 * and is always 1 at `intro = 1`.
 */
export function labelIntro(intro: number, d: number): number {
  if (intro >= 1) return 1;
  const t = clamp01(intro) * INTRO_TOTAL_MS;
  const start = staggerSlot(d) * INTRO_STAGGER_MS + INTRO_LABEL_DELAY_MS;
  const span = Math.max(1, INTRO_TOTAL_MS - start);
  return clamp01((t - start) / Math.min(INTRO_SLOT_MS, span));
}

/**
 * The whole pose (10.9 composition). Without spin, exit or focus this is step
 * 1's pose exactly. The composed pose (`stage-pose-compose.ts`) is injected
 * as `ctx.compose` by the lazily loaded spin chunk and the runtime, so the
 * first load never carries it; without it the spin term is skipped.
 */
export function poseAt(
  st: StageState,
  i: number,
  l: StageLayout,
  desktop: boolean,
  soldOut: boolean,
  ctx: Readonly<ComposeCtx> = {},
): Pose {
  // the composed pose only while something composes (it checks the rest)
  return ctx.compose && (st.spin > 0 || st.exit > 0 || st.focus > 0 || !!st.lap)
    ? ctx.compose(st, i, l, desktop, soldOut, ctx)
    : poseStep1(st, i, l, desktop, soldOut);
}

/** Step 1's pose: the rest carousel plus float-in, swap, pointer lean and idle. */
export function poseStep1(
  s: StageState,
  i: number,
  l: StageLayout,
  desktop: boolean,
  soldOut: boolean,
): Pose {
  const d = i - s.track;
  const a = Math.abs(d);
  const side = d > 0 ? 1 : d < 0 ? -1 : 0;

  // Rest pose along the carousel. Past the table the spacing keeps its last
  // slope, so far packs keep moving outward instead of piling up.
  const offset =
    a > OFFSET_LAST
      ? (OFFSET_STEPS[OFFSET_LAST] ?? 0) + (a - OFFSET_LAST) * OFFSET_TAIL_SLOPE
      : lerpTable(OFFSET_STEPS, a);
  let dx = side * (offset - a) * l.step;
  let dy = 0;
  let z = -DEPTH_PER_SLOT_ART * Math.min(a, 3) * l.artH;
  let rotX = 0;
  let rotY = -side * lerpTable(YAW, a);
  const scale = lerpTable(SCALE, a);
  let dim = lerpTable(desktop ? DIM_DESKTOP : DIM_PHONE, a);

  // Float-in: rise from below, from further back, tilted back and turned.
  const rest = 1 - slotIntro(s.intro, d);
  if (rest > 0) {
    dy += FLOAT_DROP_ART * l.artH * rest;
    z -= FLOAT_BACK_ART * l.artH * rest;
    rotX += FLOAT_TILT_RAD * rest;
    rotY += (side === 0 ? 1 : side) * FLOAT_TURN_RAD * rest;
  }

  // Category swap: sink out (and rise back in) below the slot.
  const swap = clamp01(s.swap);
  if (swap > 0) {
    dy += FLOAT_DROP_ART * l.artH * swap;
    z -= SWAP_BACK_ART * l.artH * swap;
  }

  // Pointer lean, centred pack only (fades out over one slot).
  const lean = clamp01(1 - a);
  if (lean > 0) {
    rotY += s.pointerX * POINTER_LEAN_RAD * lean;
    rotX -= s.pointerY * POINTER_LEAN_RAD * lean;
  }

  // Idle bob (all) and sway (desktop only). Zero at multiples of 3 s.
  if (s.idle !== 0) {
    const amp = clamp01(s.idle);
    const phase = (2 * Math.PI * s.idle) / IDLE_PERIOD_S;
    dy += -Math.sin(2 * phase) * IDLE_BOB_ART * l.artH * amp;
    if (desktop) rotY += Math.sin(phase) * IDLE_SWAY_RAD * amp;
  }

  if (soldOut) dim *= SOLD_OUT_DIM;

  // Normalise -0 so equal states compare equal.
  dx += 0;
  dy += 0;
  z += 0;
  rotX += 0;
  rotY += 0;
  return { dx, dy, z, rotX, rotY, rotZ: 0, scale, dim, fx: 0, fy: 0 };
}

/** The identity pose (centred pack at rest). */
export const REST_POSE: Readonly<Pose> = Object.freeze({
  dx: 0,
  dy: 0,
  z: 0,
  rotX: 0,
  rotY: 0,
  rotZ: 0,
  scale: 1,
  dim: 1,
  fx: 0,
  fy: 0,
});

/** A state at rest on the given track position. */
export function restState(track = 0): StageState {
  return {
    intro: 1,
    track,
    swap: 0,
    pointerX: 0,
    pointerY: 0,
    idle: 0,
    focus: 0,
    turn: 0,
    spin: 0,
    exit: 0,
  };
}
