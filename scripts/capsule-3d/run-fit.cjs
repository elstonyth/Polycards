/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS script: require() is its only import form */
// Fits every capsule tier's shape and camera to its own approved picture and
// writes the fit plus a check overlay (see fit.cjs, overlay.cjs).
//
//   node scripts/capsule-3d/run-fit.cjs [tier name ...]
//
// Writes docs/research/home-3d/capsule-3d/out/fit/<name>-fit.json and
// <name>-overlay.png (docs/research is gitignored: research records). The
// asset build (build-capsule-3d.cjs) reads the JSON.
const fs = require('fs');
const path = require('path');
const { repo, TIERS, pictureFile, readRgba } = require('./lib.cjs');
const { measureArt, fitTier } = require('./fit.cjs');
const { overlay } = require('./overlay.cjs');

const OUT = path.join(repo, 'docs/research/home-3d/capsule-3d/out/fit');

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const only = process.argv.slice(2);
  for (const t of TIERS) {
    if (only.length && !only.includes(t.name)) continue;
    const t0 = Date.now();
    const img = await readRgba(pictureFile(t));
    const M = measureArt(img);
    console.log(
      t.name,
      `${img.W}x${img.H}`,
      'tilt',
      M.tiltDegFromVertical.toFixed(2),
      'length',
      M.lengthPx.toFixed(1),
      'width',
      M.maxWidthPx.toFixed(1),
    );
    const r = await fitTier(
      img,
      M,
      (s) => console.log(s),
      t.cap === 'glitter' ? 'texture' : 'colour',
    );
    const out = { tier: t.name, id: t.id, picture: t.picture, ...r };
    fs.writeFileSync(
      path.join(OUT, `${t.name}-fit.json`),
      JSON.stringify(out, null, 1),
    );
    await overlay(img, out, path.join(OUT, `${t.name}-overlay.png`));
    console.log(
      t.name,
      'PICK',
      JSON.stringify(r.fit),
      'iou',
      r.pick.iou.toFixed(5),
      'seamRms',
      r.pick.seamRms.toFixed(2),
      `${((Date.now() - t0) / 1000).toFixed(0)} s`,
    );
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
