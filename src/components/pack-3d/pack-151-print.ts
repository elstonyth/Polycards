// Where the 151 back prints its live details (pack-print.ts). The zones are
// the printZones of docs/research/home-3d/pack-back/151-back-geometry.json (the
// rectangles make-plate.cjs blanks); keep the two in step. Type and positions
// were fitted to the approved back's painted text (Geist, per-word fits on the
// 897 x 1666 art): text-space px, u along a line, v down the stack.

import type { PackPrintSpec } from './pack-print';

export const PACK_151_PRINT: PackPrintSpec = {
  image: { width: 897, height: 1666 },
  orientation: 'bottom-to-top',
  zones: {
    headline: { x0: 0.65329, x1: 0.76031, y0: 0.5006, y1: 0.85834 },
    odds: { x0: 0.80825, x1: 0.92754, y0: 0.5006, y1: 0.85834 },
    buyback: { x0: 0.68004, x1: 0.89075, y0: 0.13505, y1: 0.46579 },
  },
  ink: { color: '#ffffff', softness: 0.35 },
  inset: 6,
  price: {
    font: { family: 'sans', weight: 610, size: 42.9, tracking: -0.9 },
    x: 245.6,
    baseline: 633.5,
  },
  productLine: {
    font: { family: 'sans', weight: 255, size: 29.05, tracking: -0.6, wordSpacing: 1.5 },
    x: 247.75,
    baseline: 666.5,
    separator: ' · ',
    minScale: 0.8,
  },
  odds: {
    font: { family: 'sans', weight: 255, size: 28.65, tracking: -0.65 },
    firstBaseline: 749.5,
    pitch: 33.5,
    lastBaseline: 825,
    columns: [
      { labelX: 246, valueRight: 502.3 },
      { labelX: 551.5, valueRight: 814.5 },
    ],
    valueTracking: 0.4,
    minScale: 0.6,
  },
  buyback: {
    font: { family: 'sans', weight: 278, size: 30.5, tracking: -0.36 },
    x: 899.8,
    firstBaseline: 641.9,
    pitch: 35.3,
    lastBaseline: 792,
    maxWidth: 538,
    minScale: 0.7,
  },
};
