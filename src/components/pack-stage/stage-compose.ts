/**
 * Pack stage: `poseAt` and `stageOpacity` with the focus term plugged
 * in. The composition itself lives in `stage-pose.ts`; the focus maths (`stage-focus.ts`) is injected here, so the
 * first load (which imports only `stage-pose.ts`) never carries it.
 *
 * Two departures from the plain composition:
 * - the pointer lean fades out with the gather weight (it would otherwise
 *   push the row's pitch past the +5 degree clamp);
 * - on the focused pack the extra yaw is clamped to +-5 degrees, so a back
 *   at rest stays 175..185 degrees.
 */
import type {
  ComposeCtx,
  FocusTerm,
  Pose,
  StageLayout,
  StageState,
} from './contract';
import { clampFocusExtraYaw, focusOpacity, focusPose } from './stage-focus';
import { poseAt, stageOpacity } from './stage-pose';
import { composePose } from './stage-pose-compose';
import { introOpacity } from './stage-spin-math';

export { restBlock } from './stage-pose-compose';

/** The focus term `poseAt` and `stageOpacity` take through `ctx.focusTerm`. */
export const FOCUS_TERM: FocusTerm = {
  pose: focusPose,
  clampYaw: clampFocusExtraYaw,
  opacity: focusOpacity,
};

export function poseStep2(
  st: Readonly<StageState>,
  i: number,
  l: Readonly<StageLayout>,
  desktop: boolean,
  soldOut: boolean,
  ctx: Readonly<ComposeCtx> = {},
): Pose {
  return poseAt(st, i, l, desktop, soldOut, {
    ...ctx,
    focusTerm: FOCUS_TERM,
    compose: composePose,
  });
}

export function stageOpacityStep2(
  st: Readonly<StageState>,
  i: number,
  desktop: boolean,
  count: number,
  ctx: Readonly<ComposeCtx> = {},
): number {
  const fade =
    st.focus > 0
      ? focusOpacity(st.focus, ctx.focus?.index === i, ctx.focus)
      : 1;
  return (
    stageOpacity(st, i, desktop, count, ctx) *
    introOpacity(st.intro, i - st.track) *
    fade
  );
}
