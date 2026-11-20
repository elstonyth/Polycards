/**
 * Pack stage, step 2: small constants and helpers the spin, focus and the
 * composed pose share (plan-step2.md 10.6, 10.9). Kept out of `stage-pose.ts`
 * so the first load, which imports that module, never carries them: only the
 * lazily loaded chunks (spin, runtime, focus) reach this one. Pure.
 */
import type { SpinRange } from './contract';
import { SPIN_LOCK, slotIntroLinear } from './stage-pose';

const DEG = Math.PI / 180;

/** Packs' lean mode amplitude, radians (10.9, the planner's default). */
export const LEAN = 0.61;

/**
 * Capsules' lean, radians: 25 degrees each way (owner, 2026-11-20). Used by
 * focus and spin alike; tests assert "within +-CAPSULE_LEAN", never a number.
 */
export const CAPSULE_LEAN = 25 * DEG;

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

/** The pin's length after the panel (Ciao: one more section of 1.25 screens per move). */
export const SPIN_PIN_PANELS = 1.75;
/** The exit after the pin: Ciao's camera move, scrubbed over one section. */
export const SPIN_EXIT_PANELS = 1.25;
/** Text over the stage changes once a move is this far (Ciao: 20% of a section). */
export const SPIN_TEXT_AT = 0.2;
const SPIN_TEXT_HYSTERESIS = 0.01;
const SPIN_LOCK_HYSTERESIS = 0.005;

/**
 * The pin's scroll range (document px, whole numbers): the scrollY at which
 * the panel starts sticking, the pin's length and the exit's.
 */
export function spinRangeOf(
  wrapDocTop: number,
  flowTop: number,
  panel: number,
): SpinRange | null {
  if (!(panel > 0)) return null;
  return {
    start: Math.max(0, Math.round(wrapDocTop - flowTop)),
    length: Math.round(SPIN_PIN_PANELS * panel),
    exit: Math.round(SPIN_EXIT_PANELS * panel),
  };
}

export type SpinFlags = { spinning: boolean; text: boolean; head: boolean };

/** The flags the stage's CSS reads (data attributes), with hysteresis: lock, text, header. */
export function spinFlags(
  prev: SpinFlags,
  spin: number,
  exit: number,
): SpinFlags {
  return {
    spinning: prev.spinning
      ? spin > SPIN_LOCK - SPIN_LOCK_HYSTERESIS
      : spin >= SPIN_LOCK,
    text: prev.text
      ? spin > SPIN_TEXT_AT - SPIN_TEXT_HYSTERESIS
      : spin >= SPIN_TEXT_AT,
    head: prev.head
      ? exit > SPIN_TEXT_AT - SPIN_TEXT_HYSTERESIS
      : exit >= SPIN_TEXT_AT,
  };
}
