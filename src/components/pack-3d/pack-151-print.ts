// Where the 151 back prints its live details (pack-print.ts): the shared type
// template (pack-print-template.ts) anchored to the 151 back's zones. The zones
// are the printZones of docs/research/home-3d/pack-back/151-back-geometry.json
// (the rectangles make-plate.cjs blanks); keep the two in step. Every other
// pack builds its spec the same way from its own <pack>-back-geometry.json.

import type { PackPrintSpec } from './pack-print';
import {
  packPrintSpecFromGeometry,
  type PackBackGeometry,
} from './pack-print-template';

/** 151-back-geometry.json, the parts the print reads. */
export const PACK_151_BACK_GEOMETRY: PackBackGeometry = {
  image: { width: 897, height: 1666 },
  printZones: {
    zones: [
      {
        id: 'headline',
        plate: 'live',
        rect: { x0: 0.65329, x1: 0.76031, y0: 0.5006, y1: 0.85834 },
      },
      {
        id: 'odds',
        plate: 'live',
        rect: { x0: 0.80825, x1: 0.92754, y0: 0.5006, y1: 0.85834 },
      },
      {
        id: 'buyback',
        plate: 'live',
        rect: { x0: 0.68004, x1: 0.89075, y0: 0.13505, y1: 0.46579 },
      },
      {
        id: 'oddsHeading',
        plate: 'no-odds',
        rect: { x0: 0.76254, x1: 0.80602, y0: 0.5006, y1: 0.85834 },
      },
    ],
  },
};

export const PACK_151_PRINT: PackPrintSpec = packPrintSpecFromGeometry(
  PACK_151_BACK_GEOMETRY,
);
