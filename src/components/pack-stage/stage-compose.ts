/**
 * Pack stage, step 2: `poseAt` and `stageOpacity` with the focus term plugged
 * in (plan-step2.md 10.9 "composition"). The composition itself lives in
 * `stage-pose.ts`; the focus maths (`stage-focus.ts`) is injected here, so the
 * first load (which imports only `stage-pose.ts`) never carries it.
 *
 * Two deliberate departures, both documented in integration-notes.md:
 * - the pointer lean fades out with the gather weight (it would otherwise
 *   push the row's pitch past the +5 degree clamp of 10.7);
 * - on the focused pack the extra yaw is clamped to +-5 degrees, so a back
 *   at rest stays 175..185 degrees (decision 9c).
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
