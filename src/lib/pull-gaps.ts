/**
 * Axis math for the pull-history stats chart (PullGapsChart.tsx) — pure, so
 * the scale is unit-testable without rendering.
 *
 * The reference line is the tier's expected gap (1 / published rate) when the
 * pack publishes one, else the observed mean; the axis is laid out in
 * multiples of that line (0 · avg · 2·avg · 3·avg, like the reference design)
 * and stretched further only when a bar would otherwise overflow.
 */
export interface GapScale {
  /** The value at the right edge of the bar column. */
  max: number;
  /** Tick values, left to right, starting at 0. */
  ticks: number[];
  /** The reference line's value, or null when there is nothing to anchor on. */
  line: number | null;
}

export function gapScale(
  expected: number | null,
  avg: number | null,
  gaps: readonly number[],
): GapScale {
  const line = expected ?? avg;
  const longest = Math.max(0, ...gaps);
  if (line == null || line <= 0) {
    // No reference: a plain 0..max axis with a rounded midpoint.
    const max = Math.max(1, longest);
    const mid = Math.ceil(max / 2);
    return { max, ticks: max > 1 ? [0, mid, max] : [0, max], line: null };
  }
  // The axis unit is the ROUNDED line (ticks print as whole draws) and max is
  // laid out in that same unit — a fractional line with an unrounded max put
  // the last tick past the right edge. The line itself keeps its precise
  // value, so the dashed marker sits exactly where the mean is.
  const unit = Math.max(1, Math.round(line));
  const steps = Math.max(3, Math.ceil((longest * 1.05) / unit));
  const ticks: number[] = [];
  for (let i = 0; i <= steps; i++) ticks.push(i * unit);
  return { max: steps * unit, ticks, line };
}

/** Bar width as a percentage of the column, clamped so a zero-gap row still
 *  paints a sliver and nothing overflows. */
export function gapPercent(gap: number, max: number): number {
  if (!(max > 0)) return 0;
  return Math.min(100, Math.max(gap > 0 ? 1 : 0, (gap / max) * 100));
}
