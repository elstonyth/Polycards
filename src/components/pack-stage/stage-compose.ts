/**
 * Pack stage, step 2: the whole pose with the spin and focus terms, built on
 * the unchanged `poseAt` (plan-step2.md 10.9 "composition"). This is what
 * `poseAt(s, i, l, desktop, soldOut, ctx?)` becomes at integration; until
 * then the bench (and nothing else) calls it. Pure.
 *
 * Order (10.9): the rest-carousel block -> the spin term (lerp by the gather
 * weight, only when `ctx.spin.spinPose` is given) -> the focus term -> the
 * float-in, swap, pointer-lean and idle terms added on top as today. The
 * additive terms come out of `poseAt` itself as differences, so nothing in
 * `stage-pose.ts` is duplicated except the idle bob's one private constant.
 *
 * Two deliberate departures, both documented in integration-notes.md:
 * - the pointer lean fades out with the gather weight (it would otherwise
 *   push the row's pitch past the +5 degree clamp of 10.7);
 * - on the focused pack the extra yaw is clamped to +-5 degrees, so a back
 *   at rest stays 175..185 degrees (decision 9c).
 */
import type { StageLayout, StageState } from './contract';
import type {
  FocusCtx,
  PoseBlock,
  PoseStep2,
  SpinCtx,
  StageStateStep2,
} from './contract-step2';
import { clampFocusExtraYaw, focusOpacity, focusPose } from './stage-focus';
import {
  IDLE_PERIOD_S,
  IDLE_SWAY_RAD,
  poseAt,
  slotOpacity,
  stageSpring,
} from './stage-pose';
import {
  SPIN_GATHER,
  clamp01,
  introOpacity,
  smoothstep,
} from './stage-pose-step2';

/** stage-pose.ts's private IDLE_BOB_ART, mirrored (about 0.015 world units). */
const IDLE_BOB_ART = 0.006;
/** Idle bob phase offset per pack in the row (10.9: "idle bob phase += 0.9 * i * g"). */
const SPIN_BOB_PHASE = 0.9;

export type ComposeCtx = {
  /** The spin context; without `spinPose` the spin term is skipped. */
  spin?: SpinCtx;
  /** The focus context; only read while `focus > 0`. */
  focus?: FocusCtx | null;
  /** The spin's own opacity rule (stage-spin.ts `spinOpacity`), when loaded. */
  spinOpacity?: (
    st: Readonly<StageStateStep2>,
    i: number,
    desktop: boolean,
    count: number,
  ) => number;
};

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
  const p = poseAt(clean(st), i, l, desktop, soldOut);
  return { ...p, rotZ: 0 };
}

export function poseStep2(
  st: Readonly<StageStateStep2>,
  i: number,
  l: Readonly<StageLayout>,
  desktop: boolean,
  soldOut: boolean,
  ctx: Readonly<ComposeCtx> = {},
): PoseStep2 {
  const rest = restBlock(st, i, l, desktop, soldOut);
  const s = clamp01(st.spin);
  const g = s > 0 ? smoothstep(0, SPIN_GATHER, s) : 0;

  // additive terms of today's pose, as differences from the rest block
  const noIdle = { ...st, idle: 0 };
  const noPointer = { ...noIdle, pointerX: 0, pointerY: 0 };
  const moveIn = poseAt(noPointer, i, l, desktop, soldOut); // float-in + swap
  const lean = poseAt(noIdle, i, l, desktop, soldOut); // + pointer lean

  let block: PoseBlock = rest;
  let fx = 0;
  let fy = 0;
  const spin = ctx.spin;
  if (spin?.spinPose && (s > 0 || (spin.exit ?? 0) > 0) && !(st.focus > 0)) {
    const b = spin.spinPose(rest, st, i, l, desktop, { ...spin, soldOut });
    fx = b.fx ?? 0;
    fy = b.fy ?? 0;
    block = b;
  }

  const focusing = st.focus > 0 && ctx.focus;
  if (focusing && ctx.focus) {
    const f = focusPose(
      block,
      st.focus,
      st.turn,
      i,
      st.track,
      l,
      desktop,
      soldOut,
      ctx.focus,
    );
    fx = f.fx;
    fy = f.fy;
    block = f;
  }

  const pointerFade = 1 - g;
  let dx = block.dx + (moveIn.dx - rest.dx);
  let dy = block.dy + (moveIn.dy - rest.dy);
  let z = block.z + (moveIn.z - rest.z);
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
  if (focusing && ctx.focus && i === ctx.focus.index)
    extraYaw = clampFocusExtraYaw(extraYaw, st.focus);

  dx += 0;
  dy += 0;
  z += 0;
  return {
    dx,
    dy,
    z,
    rotX: rotX + 0,
    rotY: block.rotY + floatYaw + extraYaw + 0,
    rotZ: block.rotZ + 0,
    scale: block.scale,
    dim: block.dim,
    fx: fx + 0,
    fy: fy + 0,
  };
}

/**
 * The whole opacity a pack draws with: the reach fade (the spin's, when it
 * runs), the swap fade, the float-in fade (`introOpacity`, 10.10) and the
 * focus neighbour fade. What `stageOpacity` becomes at integration.
 */
export function stageOpacityStep2(
  st: Readonly<StageStateStep2>,
  i: number,
  desktop: boolean,
  count: number,
  ctx: Readonly<ComposeCtx> = {},
): number {
  const d = i - st.track;
  const reach =
    ctx.spinOpacity && st.spin > 0 && !(st.focus > 0)
      ? ctx.spinOpacity(st, i, desktop, count)
      : slotOpacity(d, desktop);
  const focused = ctx.focus ? i === ctx.focus.index : false;
  const focusFade = st.focus > 0 ? focusOpacity(st.focus, focused) : 1;
  return (
    reach *
    (1 - stageSpring(clamp01(st.swap))) *
    introOpacity(st.intro, d) *
    focusFade
  );
}
