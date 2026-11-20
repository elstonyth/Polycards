/**
 * Chapter stops (plan-step2 section 2 "Mapping"), as pure maths so the
 * measuring component stays thin and the rules are unit-tested.
 *
 * A stop is the page scrollY at which its chapter rests:
 * - the back (stop 1): the focus wrapper's top;
 * - a tier or the odds board: the moment that section's top reaches 0.42 of
 *   the panel's height (below the panel's top edge).
 * Stops are reported in order and never decrease (a later section measured
 * above an earlier one, mid-layout, is pushed down to it); negative values
 * are clamped to 0.
 */
import type { FlowStop, FlowStopKind } from './types';

/** Where a tier or the odds board rests, as a fraction of the panel height. */
export const STOP_ANCHOR = 0.42;

export type MeasuredSection = {
  kind: FlowStopKind;
  /** The section's top, in page pixels (getBoundingClientRect().top + scrollY). */
  top: number;
};

export function stopsFrom(
  wrapperTop: number,
  sections: readonly MeasuredSection[],
  panelTop: number,
  panelHeight: number,
): FlowStop[] {
  const out: FlowStop[] = [
    { y: Math.max(0, wrapperTop - panelTop), kind: 'back' },
  ];
  for (const s of sections) {
    const y = Math.max(0, s.top - panelTop - STOP_ANCHOR * panelHeight);
    const prev = out[out.length - 1]!.y;
    out.push({ y: Math.max(prev, y), kind: s.kind });
  }
  return out;
}

/** The index of the stop the page rests at or has passed (0 = the back).
 *  Halfway between two stops counts as the next one (the rounded stop). */
export function stopIndexAt(
  stops: readonly FlowStop[],
  scrollY: number,
): number {
  let index = 0;
  for (let i = 1; i < stops.length; i++) {
    const a = stops[i - 1]!.y;
    const b = stops[i]!.y;
    if (scrollY >= (a + b) / 2) index = i;
  }
  return index;
}

/** The yaw beat of a tier stop on desktop: -6, 0, +6 degrees in turn
 *  (0, 1, 2), or null away from the tiers. */
export function beatOf(
  stops: readonly FlowStop[],
  index: number,
): number | null {
  const stop = stops[index];
  if (!stop || stop.kind !== 'tier') return null;
  const tierIndex = stops
    .slice(0, index)
    .filter((s) => s.kind === 'tier').length;
  return tierIndex % 3;
}
