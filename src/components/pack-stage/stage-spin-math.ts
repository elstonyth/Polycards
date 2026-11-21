/**
 * Pack stage: small constants and helpers the spin, focus and the
 * composed pose share. Kept out of `stage-pose.ts`
 * so the first load, which imports that module, never carries them: only the
 * lazily loaded chunks (spin, runtime, focus) reach this one. Pure.
 */
import { slotIntroLinear } from './stage-pose';

/** Packs' lean mode amplitude, radians. */
export const LEAN = 0.61;

/** End of the full-turn row's gather; the composed pose weighs its idle terms by it. */
export const SPIN_GATHER = 0.15;

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Ease-out cubic: 0 to 1, clamped, decelerating. */
export function easeOutCubic(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
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
 * Float-in visibility (as the loader leaves): each pack fades in over the first third of its rise, like the CSS
 * `stage-in` fade, so an arrival at `intro` 0 draws nothing.
 */
export function introOpacity(intro: number, d: number): number {
  return smoothstep(0, 0.35, slotIntroLinear(intro, d));
}
