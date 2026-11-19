// Each plate's own white and print softness, measured against its fixed white
// wording (docs/research/home-3d/pack-3d/harness-text/measure-raw.cjs, results
// in live-text/raw-packs/measure.json). Pass as the geometry's printInk:
//
//   packPrintSpecFromGeometry({ ...geometryJson, printInk: PACK_PRINT_INK[slug] })
//
// A slug missing here prints with the template's ink (#ffffff, 0.35).
//
// colour: the stroke-interior level of the plate's fixed white (heading and
//   body copy; white-plateau.cjs). 151's plate prints #ffffff. The four raw
//   plates print #ecebf1 (the plate agent's white ink): flat on delta-reign
//   and ah, with resampling overshoot up to 255 at stroke edges on cr and 30th
//   (their median inked pixel is still 235-237).
// softness: gaussian sigma (px at the plate's size) that gives the live price
//   strokes the same 10-90% edge width, relative to the plate's own "Pull odds
//   (by rarity)" heading, as on 151 at 0.35 (the accepted 151 print). The
//   resampled plates (cr 0.931, 30th 0.787) soften their fixed wording, so
//   they take more; delta-reign and ah carry it 1:1 from a slightly sharper
//   source than 151's plate, so they take less.

import type { PackPrintSpec } from './pack-print';

export const PACK_PRINT_INK: Record<string, PackPrintSpec['ink']> = {
  '151': { color: '#ffffff', softness: 0.35 },
  cr: { color: '#ecebf1', softness: 0.4 },
  'delta-reign': { color: '#ecebf1', softness: 0.31 },
  '30th-celebration': { color: '#ecebf1', softness: 0.37 },
  ah: { color: '#ecebf1', softness: 0.3 },
  // Graded family (2026-11-19, live-text/graded-packs/measure.json): the fixed
  // wording is each pack's own pale colour, not white, measured at the stroke
  // interior of the "Pull odds (by rarity)" heading and the body copy (the two
  // agree on every plate). The odds-box outline is metal and not the
  // reference. All six plates carry 151's art 1:1 (zone ratios 1).
  'bronze-pack': { color: '#e1c3a9', softness: 0.31 },
  'silver-pack': { color: '#e8e6e9', softness: 0.32 },
  'gold-pack': { color: '#eed7bb', softness: 0.34 },
  'diamond-pack': { color: '#f1eff2', softness: 0.32 },
  'poncho-pack': { color: '#b2d9ef', softness: 0.29 },
  // measured on the regenerated (darker film) plate. Its fixed wording is
  // sharper than 151's: even unblurred the live edges come out 3% softer than
  // the target, so 0.25 (effectively no blur).
  'platinum-pack': { color: '#e9e0e6', softness: 0.25 },
};
