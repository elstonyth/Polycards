/**
 * Pack stage, step 2: the composed pose (plan-step2.md 10.9 "composition"):
 * the rest-carousel block -> the spin term (`ctx.spin.spinPose`) -> the
 * focus term (`ctx.focusTerm`) -> the float-in, swap, pointer-lean and idle
 * terms of step 1 added on top. Pure. Reached only through `ctx.compose`
 * (the spin chunk, the runtime, `stage-compose.ts`), never the first load.
 */
import type {
  ComposeCtx,
  Pose,
  PoseBlock,
  StageLayout,
  StageState,
} from './contract';
import {
  IDLE_BOB_ART,
  IDLE_PERIOD_S,
  IDLE_SWAY_RAD,
  poseStep1,
} from './stage-pose';
import { SPIN_GATHER, clamp01, smoothstep } from './stage-spin-math';

/** Idle bob phase offset per pack in the spin row (10.9: "idle bob phase += 0.9 * i * g"). */
const SPIN_BOB_PHASE = 0.9;

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
 * The whole pose while the spin row or focus runs (10.9 composition). The
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
  const s = clamp01(st.spin ?? 0);
  const exit = clamp01(st.exit ?? 0);
  const spin = ctx.spin;
  const spinning = !!spin?.spinPose && (s > 0 || exit > 0) && !(st.focus > 0);
  const focus = st.focus > 0 && ctx.focus && ctx.focusTerm ? ctx.focus : null;

  const rest = restBlock(st, i, l, desktop, soldOut);
  // The row's formation weight (the full-turn row's gather, Ciao's row's ease
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
