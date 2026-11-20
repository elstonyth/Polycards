/**
 * Pack stage, step 2: the first-load additions the brief puts in
 * `stage-pose.ts` (plan-step2.md 10.6, 10.9 and 10.10). They live here until
 * the integration step MOVES them into `stage-pose.ts` (which another agent
 * holds right now). Pure, tiny, no imports but `stage-pose`.
 */
import { slotIntroLinear } from './stage-pose';

const DEG = Math.PI / 180;

/** Packs' lean mode amplitude, radians (10.9, the planner's default). -> stage-pose.ts */
export const LEAN = 0.61;

/**
 * Capsules' lean, radians: 25 degrees each way, decided by the owner on
 * 2026-11-20 ("25"). Used by focus and spin alike; tests assert "within
 * +-CAPSULE_LEAN", never a number. -> stage-pose.ts
 */
export const CAPSULE_LEAN = 25 * DEG;

/** Below this the spin counts as stopped: controls back, focus allowed (10.3, 10.4). -> stage-pose.ts */
export const SPIN_LOCK = 0.02;

/** End of the spin's gather (10.9); here so the pose can weigh its idle terms without stage-spin.ts. */
export const SPIN_GATHER = 0.15;

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/**
 * Float-in visibility (10.10 item 5): each pack fades in over the first third
 * of its rise, like the CSS `stage-in` fade, so an arrival at `intro` 0 draws
 * nothing. `stageOpacity` and `tileVars`' `op` multiply it in. -> stage-pose.ts
 */
export function introOpacity(intro: number, d: number): number {
  return smoothstep(0, 0.35, slotIntroLinear(intro, d));
}

/** Exponential follow with time constant `tauMs` (the spin's 150 ms, focus's 90 ms). */
export function dampedFollow(
  current: number,
  target: number,
  dtMs: number,
  tauMs: number,
  snap = 1e-4,
): number {
  if (!(dtMs > 0)) return current;
  const next = current + (target - current) * (1 - Math.exp(-dtMs / tauMs));
  return Math.abs(target - next) < snap ? target : next;
}
