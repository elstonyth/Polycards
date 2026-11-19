// The raw and graded packs' back geometry (image size and printZones), copied from
// docs/research/home-3d/pack-back/<pack>/<pack>-back-geometry.json on
// 2026-11-19. docs/research is not tracked, so tests and callers read it from
// here; pack-print-raw-plates.test.ts checks it against the JSON when present.

import type { PackBackGeometry } from './pack-print-template';

type Rect = { x0: number; x1: number; y0: number; y1: number };
const geometry = (
  width: number,
  height: number,
  headline: Rect,
  odds: Rect,
  buyback: Rect,
  oddsHeading: Rect,
): PackBackGeometry => ({
  image: { width, height },
  printZones: {
    zones: [
      { id: 'headline', plate: 'live', rect: headline },
      { id: 'odds', plate: 'live', rect: odds },
      { id: 'buyback', plate: 'live', rect: buyback },
      { id: 'oddsHeading', plate: 'no-odds', rect: oddsHeading },
    ],
  },
});

export const RAW_PACK_BACK_GEOMETRY: Record<string, PackBackGeometry> = {
  cr: geometry(
    853,
    1666,
    { x0: 0.65357, x1: 0.75835, y0: 0.49947, y1: 0.83252 },
    { x0: 0.80528, x1: 0.92207, y0: 0.49947, y1: 0.83252 },
    { x0: 0.67977, x1: 0.88605, y0: 0.15914, y1: 0.46705 },
    { x0: 0.76053, x1: 0.8031, y0: 0.49947, y1: 0.83252 },
  ),
  'delta-reign': geometry(
    914,
    1666,
    { x0: 0.65317, x1: 0.75821, y0: 0.497, y1: 0.85474 },
    { x0: 0.80525, x1: 0.92232, y0: 0.497, y1: 0.85474 },
    { x0: 0.67943, x1: 0.88621, y0: 0.13145, y1: 0.46218 },
    { x0: 0.76039, x1: 0.80306, y0: 0.497, y1: 0.85474 },
  ),
  '30th-celebration': geometry(
    737,
    1474,
    { x0: 0.64853, x1: 0.75105, y0: 0.49409, y1: 0.81231 },
    { x0: 0.79696, x1: 0.91122, y0: 0.49409, y1: 0.81231 },
    { x0: 0.67416, x1: 0.87598, y0: 0.16893, y1: 0.46313 },
    { x0: 0.75318, x1: 0.79483, y0: 0.49409, y1: 0.81231 },
  ),
  ah: geometry(
    925,
    1666,
    { x0: 0.65189, x1: 0.75568, y0: 0.5, y1: 0.85774 },
    { x0: 0.80216, x1: 0.91784, y0: 0.5, y1: 0.85774 },
    { x0: 0.67784, x1: 0.88216, y0: 0.13445, y1: 0.46519 },
    { x0: 0.75784, x1: 0.8, y0: 0.5, y1: 0.85774 },
  ),
};

/** The six graded packs' back geometry, same source and date (platinum-pack
 *  from its regenerated plate; its geometry did not change). */
export const GRADED_PACK_BACK_GEOMETRY: Record<string, PackBackGeometry> = {
  'bronze-pack': geometry(
    925,
    1666,
    { x0: 0.65081, x1: 0.75459, y0: 0.509, y1: 0.86675 },
    { x0: 0.80108, x1: 0.91676, y0: 0.509, y1: 0.86675 },
    { x0: 0.67676, x1: 0.88108, y0: 0.14346, y1: 0.47419 },
    { x0: 0.75676, x1: 0.79892, y0: 0.509, y1: 0.86675 },
  ),
  'silver-pack': geometry(
    926,
    1666,
    { x0: 0.65011, x1: 0.75378, y0: 0.5084, y1: 0.86615 },
    { x0: 0.80022, x1: 0.91577, y0: 0.5084, y1: 0.86615 },
    { x0: 0.67603, x1: 0.88013, y0: 0.14286, y1: 0.47359 },
    { x0: 0.75594, x1: 0.79806, y0: 0.5084, y1: 0.86615 },
  ),
  'gold-pack': geometry(
    919,
    1666,
    { x0: 0.6518, x1: 0.75626, y0: 0.512, y1: 0.86975 },
    { x0: 0.80305, x1: 0.91948, y0: 0.512, y1: 0.86975 },
    { x0: 0.67791, x1: 0.88357, y0: 0.14646, y1: 0.47719 },
    { x0: 0.75843, x1: 0.80087, y0: 0.512, y1: 0.86975 },
  ),
  'platinum-pack': geometry(
    931,
    1666,
    { x0: 0.64984, x1: 0.75295, y0: 0.509, y1: 0.86675 },
    { x0: 0.79914, x1: 0.91407, y0: 0.509, y1: 0.86675 },
    { x0: 0.67562, x1: 0.87863, y0: 0.14346, y1: 0.47419 },
    { x0: 0.7551, x1: 0.79699, y0: 0.509, y1: 0.86675 },
  ),
  'diamond-pack': geometry(
    917,
    1666,
    { x0: 0.65213, x1: 0.75682, y0: 0.5114, y1: 0.86915 },
    { x0: 0.80371, x1: 0.92039, y0: 0.5114, y1: 0.86915 },
    { x0: 0.6783, x1: 0.88441, y0: 0.14586, y1: 0.47659 },
    { x0: 0.759, x1: 0.80153, y0: 0.5114, y1: 0.86915 },
  ),
  'poncho-pack': geometry(
    929,
    1666,
    { x0: 0.65016, x1: 0.7535, y0: 0.5108, y1: 0.86855 },
    { x0: 0.79978, x1: 0.91496, y0: 0.5108, y1: 0.86855 },
    { x0: 0.676, x1: 0.87944, y0: 0.14526, y1: 0.47599 },
    { x0: 0.75565, x1: 0.79763, y0: 0.5108, y1: 0.86855 },
  ),
};
