/**
 * Pack stage, step 2: small constants and helpers the spin, focus and the
 * composed pose share (plan-step2.md 10.6, 10.9). Kept out of `stage-pose.ts`
 * so the first load, which imports that module, never carries them: only the
 * lazily loaded chunks (spin, runtime, focus) reach this one. Pure.
 */
import { slotIntroLinear } from './stage-pose';
import { CAPSULE_LIMITS } from './stage-capsule-lean';

/** Packs' lean mode amplitude, radians (10.9, the planner's default). */
export const LEAN = 0.61;

/**
 * Capsules' lean, radians: 25 degrees each way (owner, 2026-11-20). Used by
 * focus and spin alike; tests assert "within +-CAPSULE_LEAN", never a number.
 */
export const CAPSULE_LEAN = CAPSULE_LIMITS.yaw;

/** End of the full-turn row's gather (10.9); the composed pose weighs its idle terms by it. */
export const SPIN_GATHER = 0.15;

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
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

/**
 * Float-in visibility (10.10 item 5, the "All packs" arrival; wired with
 * focus): each pack fades in over the first third of its rise, like the CSS
 * `stage-in` fade, so an arrival at `intro` 0 draws nothing.
 */
export function introOpacity(intro: number, d: number): number {
  return smoothstep(0, 0.35, slotIntroLinear(intro, d));
}
