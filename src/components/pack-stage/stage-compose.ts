/**
 * Pack stage: the focus term `poseAt` takes through `ctx.focusTerm`. The
 * composition itself lives in `stage-pose.ts`; the focus maths
 * (`stage-focus.ts`) is injected here, so the first load (which imports only
 * `stage-pose.ts`) never carries it.
 *
 * On the focused pack the extra yaw is clamped to +-5 degrees, so a back at
 * rest stays 175..185 degrees.
 */
import type { FocusTerm } from './contract';
import { clampFocusExtraYaw, focusOpacity, focusPose } from './stage-focus';

/** The focus term `poseAt` and `stageOpacity` take through `ctx.focusTerm`. */
export const FOCUS_TERM: FocusTerm = {
  pose: focusPose,
  clampYaw: clampFocusExtraYaw,
  opacity: focusOpacity,
};
