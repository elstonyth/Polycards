/**
 * Pack stage: small constants and helpers the spin, focus and the
 * composed pose share. Kept out of `stage-pose.ts`
 * so the first load, which imports that module, never carries them: only the
 * lazily loaded chunks (spin, runtime, focus) reach this one. Pure.
 */

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
