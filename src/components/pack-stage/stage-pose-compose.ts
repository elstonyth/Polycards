/**
 * Pack stage: the composed pose:
 * the rest-carousel block -> the spin term (`ctx.spin.spinPose`) -> the
 * focus term (`ctx.focusTerm`) -> the float-in, swap, pointer-lean and idle
 * terms of the plain carousel added on top. Pure. Reached only through `ctx.compose`
 * (the spin chunk, the runtime, `stage-compose.ts`), never the first load.
 */
import type {
  ComposeCtx,
  FocusCtx,
  Pose,
  PoseBlock,
  StageLayout,
  StageState,
} from './contract';
import { spreadAt } from './stage-flow';
import { power1InOut } from './stage-focus';
import {
  IDLE_BOB_ART,
  IDLE_PERIOD_S,
  IDLE_SWAY_RAD,
  poseStep1,
  stageOpacity,
  stageSpring,
} from './stage-pose';
import { SPIN_GATHER, clamp01, smoothstep } from './stage-spin-math';

/** Idle bob phase offset per pack in the spin row ("idle bob phase += 0.9 * i * g"). */
const SPIN_BOB_PHASE = 0.9;

/** The row at rest under a lap: no focus, no lineup, no lap. */
function plainOf(st: Readonly<StageState>): StageState {
  return { ...st, focus: 0, spin: 0, exit: 0, focusOn: null, lap: null };
}

/**
 * The lap's pose: the row's own rest pose (live idle
 * and pointer included, so the end of Return is the row exactly); the chosen
 * pack offset from one panel below (power1InOut of the rise), the others at
 * their row offsets widened by the spread (5 to 1 over Return).
 */
function lapPose(
  st: Readonly<StageState>,
  i: number,
  l: StageLayout,
  desktop: boolean,
  soldOut: boolean,
): Pose {
  const lap = st.lap!;
  const p = poseStep1(plainOf(st), i, l, desktop, soldOut);
  if (i === Math.round(st.track))
    return { ...p, fy: p.fy + 1 - power1InOut(clamp01(lap.rise)) + 0 };
  const k = spreadAt(lap.ret) - 1;
  if (k === 0) return p;
  const slot = (i - st.track) * l.step;
  return { ...p, dx: p.dx + k * (p.dx + slot) + 0 };
}

function clean(st: Readonly<StageState>): StageState {
  return { ...st, intro: 1, swap: 0, pointerX: 0, pointerY: 0, idle: 0 };
}

/** `poseAt`'s rest-carousel block (before float-in, swap, pointer and idle). */
export function restBlock(
  st: Readonly<StageState>,
  i: number,
  l: Readonly<StageLayout>,
  desktop: boolean,
  soldOut: boolean,
): PoseBlock {
  const p = poseStep1(clean(st), i, l, desktop, soldOut);
  return {
    dx: p.dx,
    dy: p.dy,
    z: p.z,
    rotX: p.rotX,
    rotY: p.rotY,
    rotZ: 0,
    scale: p.scale,
    dim: p.dim,
  };
}

/**
 * The hand-off from Closing to the lineup: while a pack
 * is focused, `st.spin` is the local progress from Closing to the lineup
 * rest and `st.exit` the lineup's exit. Null: no hand-off (the focused view,
 * or no focus). Its weight h is power1InOut of that progress, applied once
 * here (the row is then drawn at spin 1); through the exit it is 1.
 */
function handoffOf(
  st: Readonly<StageState>,
  ctx: Readonly<ComposeCtx>,
): { focus: FocusCtx; h: number } | null {
  const focus = st.focus > 0 && ctx.focus && ctx.focusTerm ? ctx.focus : null;
  const s = clamp01(st.spin ?? 0);
  const exit = clamp01(st.exit ?? 0);
  if (!focus || !(s > 0 || exit > 0)) return null;
  return { focus, h: exit > 0 ? 1 : power1InOut(s) };
}

/**
 * A pack's whole opacity, the hand-off included (the runtime and the CSS
 * tiles draw with it). `copy`: a repeat of the row (`lineupCopies`), whose
 * category fade the caller adds. In the hand-off the chosen pack stays whole
 * while it is the centred one (moved off centre by the pick, it takes the
 * row's reach as h comes in) and the others (its own repeats included) fade in with h at the row's
 * reach; otherwise the reach, the category switch and the focus fade, as
 * before.
 */
export function composeOpacity(
  st: Readonly<StageState>,
  i: number,
  desktop: boolean,
  count: number,
  ctx: Readonly<ComposeCtx> = {},
  copy = 0,
): number {
  const lap = st.lap;
  if (lap) {
    // the lap draws the row alone: no repeats; nothing in the free span;
    // the others fade in with Return
    if (copy !== 0 || lap.free) return 0;
    const base = stageOpacity(plainOf(st), i, desktop, count, ctx);
    return i === Math.round(st.track) ? base : base * clamp01(lap.ret);
  }
  const ho = ctx.spinOpacity ? handoffOf(st, ctx) : null;
  if (!ho) {
    if (copy !== 0)
      return ctx.spinOpacity ? ctx.spinOpacity(st, i, desktop, count, copy) : 0;
    const f = st.focus > 0 && ctx.focus && ctx.focusTerm ? ctx.focus : null;
    const fade = f ? ctx.focusTerm!.opacity(st.focus, i === f.index, f) : 1;
    return stageOpacity(st as StageState, i, desktop, count, ctx) * fade;
  }
  const swap = copy === 0 ? 1 - stageSpring(clamp01(st.swap)) : 1;
  const row = ctx.spinOpacity!({ ...st, spin: 1 }, i, desktop, count, copy);
  // the chosen pack is whole in its slot; once the lineup has moved it
  // (the pick) it fades at the row's reach like any other pack
  if (copy === 0 && i === ho.focus.index) return swap * (1 + (row - 1) * ho.h);
  return ho.h * row * swap;
}

/**
 * The whole pose while the spin row or focus runs (composition). The
 * pointer lean fades out with the row's formation weight, so the row's pitch
 * is the row's own. `poseAt` calls it through `ctx.compose`.
 */
export function composePose(
  st: StageState,
  i: number,
  l: StageLayout,
  desktop: boolean,
  soldOut: boolean,
  ctx: Readonly<ComposeCtx> = {},
): Pose {
  if (st.lap) return lapPose(st, i, l, desktop, soldOut);
  const s = clamp01(st.spin ?? 0);
  const exit = clamp01(st.exit ?? 0);
  const spin = ctx.spin;
  const spinning = !!spin?.spinPose && (s > 0 || exit > 0) && !(st.focus > 0);
  const focus = st.focus > 0 && ctx.focus && ctx.focusTerm ? ctx.focus : null;

  const rest = restBlock(st, i, l, desktop, soldOut);
  // The row's formation weight (the full-turn row's gather, the row's ease
  // both start at 0 and reach 1): the pointer lean and the bob phase follow it.
  const g = s > 0 ? smoothstep(0, SPIN_GATHER, s) : 0;

  // additive terms of today's pose, as differences from the rest block
  const noIdle = { ...st, idle: 0 };
  const noPointer = { ...noIdle, pointerX: 0, pointerY: 0 };
  const moveIn = poseStep1(noPointer, i, l, desktop, soldOut); // float-in + swap
  const lean = poseStep1(noIdle, i, l, desktop, soldOut); // + pointer lean

  let block: PoseBlock = rest;
  let fx = 0;
  let fy = 0;
  if (spinning && spin?.spinPose) {
    const b = spin.spinPose(rest, st, i, l, desktop, { ...spin, soldOut });
    fx = b.fx ?? 0;
    fy = b.fy ?? 0;
    block = b;
  }
  if (focus && ctx.focusTerm) {
    const f = ctx.focusTerm.pose(
      block,
      st.focus,
      st.turn,
      i,
      st.track,
      l,
      desktop,
      soldOut,
      focus,
    );
    fx = f.fx;
    fy = f.fy;
    block = f;
    // the hand-off: the chosen pack moves from its Closing key to its slot
    // in the lineup (front-facing at both ends, so it never turns); the
    // others take their row slots at a spacing falling from 5 to 1, fading
    // in with h (composeOpacity)
    const ho = spin?.spinPose ? handoffOf(st, ctx) : null;
    if (ho && spin?.spinPose) {
      const chosen = i === focus.index && !spin.copy;
      const r = spin.spinPose(rest, { ...st, spin: 1 }, i, l, desktop, {
        ...spin,
        soldOut,
        spread: chosen ? 1 : spreadAt(ho.h),
      });
      const w = chosen ? ho.h : 1;
      const mix = (a: number, b: number) => a + (b - a) * w;
      block = {
        dx: mix(f.dx, r.dx),
        dy: mix(f.dy, r.dy),
        z: mix(f.z, r.z),
        rotX: mix(f.rotX, r.rotX),
        rotY: mix(f.rotY, r.rotY),
        rotZ: mix(f.rotZ, r.rotZ),
        scale: mix(f.scale, r.scale),
        dim: mix(f.dim, r.dim),
      };
      fx = mix(f.fx, r.fx ?? 0);
      fy = mix(f.fy, r.fy ?? 0);
    }
  }

  const pointerFade = 1 - g;
  let dy = block.dy + (moveIn.dy - rest.dy);
  let rotX = block.rotX + (moveIn.rotX - rest.rotX);
  let extraYaw = (lean.rotY - moveIn.rotY) * pointerFade;
  rotX += (lean.rotX - moveIn.rotX) * pointerFade;
  const floatYaw = moveIn.rotY - rest.rotY;

  if (st.idle !== 0) {
    const amp = clamp01(st.idle);
    const phase =
      (2 * Math.PI * st.idle) / IDLE_PERIOD_S + SPIN_BOB_PHASE * i * g;
    dy += -Math.sin(2 * phase) * IDLE_BOB_ART * l.artH * amp;
    if (desktop) extraYaw += Math.sin(phase) * IDLE_SWAY_RAD * amp;
  }
  if (focus && ctx.focusTerm && i === focus.index)
    extraYaw = ctx.focusTerm.clampYaw(extraYaw, st.focus);

  return {
    dx: block.dx + (moveIn.dx - rest.dx) + 0,
    dy: dy + 0,
    z: block.z + (moveIn.z - rest.z) + 0,
    rotX: rotX + 0,
    rotY: block.rotY + floatYaw + extraYaw + 0,
    rotZ: block.rotZ + 0,
    scale: block.scale,
    dim: block.dim,
    fx: fx + 0,
    fy: fy + 0,
  };
}
