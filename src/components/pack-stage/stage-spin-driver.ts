/**
 * Pack stage: Ciao's `easeOutCubic`, the one export of the old spin driver
 * that the pager and the flow still use. Pure.
 */
import { clamp01 } from './stage-spin-math';

/** Ciao's `easeOutCubic`. */
export function easeOutCubic(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}
