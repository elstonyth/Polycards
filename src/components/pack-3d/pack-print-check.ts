// Fit checks on a laid-out pack print (pack-print.ts): every run's box inside
// the zone it belongs to, no two runs touching, and no fit that changed the
// wording or broke a floor. Pure, so tests and the capture stage share it.

import type { PrintLayout, PrintRun, TextRect } from './pack-print';

/** A run's ink box in text space: advance along u, ascent/descent across v. */
export type RunBox = TextRect;

/** Ascent and descent of a run below/above its baseline, px. */
export type RunMetrics = (run: PrintRun) => { ascent: number; descent: number };

/** Geist-like defaults: cap/ascender about 0.75 em, descender about 0.22 em. */
export const DEFAULT_RUN_METRICS: RunMetrics = (run) => ({
  ascent: 0.75 * run.font.size,
  descent: 0.22 * run.font.size,
});

export const zoneOfRun = (run: PrintRun): keyof PrintLayout['zones'] =>
  run.role === 'buyback'
    ? 'buyback'
    : run.role.startsWith('odds')
      ? 'odds'
      : 'headline';

export function runBox(
  run: PrintRun,
  metrics: RunMetrics = DEFAULT_RUN_METRICS,
): RunBox {
  const u0 = run.align === 'right' ? run.x - run.width : run.x;
  const { ascent, descent } = metrics(run);
  return { u0, u1: u0 + run.width, v0: run.y - ascent, v1: run.y + descent };
}

const overlaps = (a: RunBox, b: RunBox) =>
  a.u0 < b.u1 && b.u0 < a.u1 && a.v0 < b.v1 && b.v0 < a.v1;

/**
 * Everything wrong with a layout, as readable lines (empty = clean). `slack`
 * forgives sub-pixel rounding at the zone edges.
 */
export function printLayoutIssues(
  layout: PrintLayout,
  metrics: RunMetrics = DEFAULT_RUN_METRICS,
  slack = 0.5,
): string[] {
  const issues: string[] = [];
  const boxes = layout.runs.map((r) => runBox(r, metrics));
  layout.runs.forEach((run, i) => {
    const b = boxes[i];
    const z = layout.zones[zoneOfRun(run)];
    if (!b) return;
    const out = [
      b.u0 < z.u0 - slack && `starts ${(z.u0 - b.u0).toFixed(1)}px before`,
      b.u1 > z.u1 + slack && `ends ${(b.u1 - z.u1).toFixed(1)}px past`,
      b.v0 < z.v0 - slack && `rises ${(z.v0 - b.v0).toFixed(1)}px above`,
      b.v1 > z.v1 + slack && `drops ${(b.v1 - z.v1).toFixed(1)}px below`,
    ].filter(Boolean);
    if (out.length)
      issues.push(
        `${run.role} "${run.text}" ${out.join(', ')} its ${zoneOfRun(run)} zone`,
      );
  });
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i],
        b = boxes[j];
      if (a && b && overlaps(a, b))
        issues.push(
          `"${layout.runs[i]?.text}" collides with "${layout.runs[j]?.text}"`,
        );
    }
  const fit = layout.fit;
  if (fit?.price?.belowMin)
    issues.push(`price set at ${fit.price.scale.toFixed(3)}, below its floor`);
  if (fit?.productLine?.dropped.length)
    issues.push(
      `product line dropped ${fit.productLine.dropped.map((d) => `"${d}"`).join(', ')}`,
    );
  if (fit?.buyback?.overflow)
    issues.push('buyback paragraph runs past its lowest baseline');
  return issues;
}
