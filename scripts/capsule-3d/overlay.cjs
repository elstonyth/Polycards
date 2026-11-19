/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS script: require() is its only import form */
// Fit check overlays: the fitted pill outline (green), the fitted seam ring
// (red, front half), the measured seam points (yellow) and, once fitted, the
// vector logo's outline (cyan) drawn over the tier's own picture.
const {
  restPose,
  rayAt,
  hitPill,
  toLocal,
  toCamera,
  project,
  phiM,
  raw4,
} = require('./lib.cjs');

function plot(buf, W, H, x, y, c, r = 1) {
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) {
      const xx = Math.round(x + dx),
        yy = Math.round(y + dy);
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      const q = (yy * W + xx) * 4;
      buf[q] = c[0];
      buf[q + 1] = c[1];
      buf[q + 2] = c[2];
      buf[q + 3] = 255;
    }
}

/**
 * @param img     the picture (readRgba)
 * @param fitJson the tier's fit result
 * @param logoAt  optional (phi, m) -> logo coverage 0..1
 */
async function overlay(img, fitJson, file, logoAt = null) {
  const { W, H } = img;
  const buf = Buffer.from(img.d);
  // darken the background so the lines read
  for (let i = 0; i < W * H; i++) {
    const a = buf[i * 4 + 3] / 255;
    for (let q = 0; q < 3; q++)
      buf[i * 4 + q] = Math.round(buf[i * 4 + q] * a + 10 * (1 - a));
    buf[i * 4 + 3] = 255;
  }
  const P = restPose(fitJson.fit);
  const hit = new Uint8Array(W * H),
    logo = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const h = hitPill(P, rayAt(P, W, H, x + 0.5, y + 0.5));
      if (!h) continue;
      hit[y * W + x] = 1;
      if (logoAt) {
        const [phi, m] = phiM(P, toLocal(P, h.p));
        if (logoAt(phi, m) >= 0.5) logo[y * W + x] = 1;
      }
    }
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (hit[i] !== hit[i + 1] || hit[i] !== hit[i + W])
        plot(buf, W, H, x, y, [40, 255, 90], 1);
      if (logoAt && (logo[i] !== logo[i + 1] || logo[i] !== logo[i + W]))
        plot(buf, W, H, x, y, [0, 230, 255], 0);
    }
  // seam ring, front half (facing the camera)
  for (let k = 0; k < 1440; k++) {
    const ph = (k / 1440) * 2 * Math.PI;
    const l = [Math.sin(ph), P.SEAM, Math.cos(ph)];
    const c = toCamera(P, l);
    const nC = toCamera(P, [l[0], P.SEAM, l[2]]);
    const centre = toCamera(P, [0, P.SEAM, 0]);
    const n = [nC[0] - centre[0], nC[1] - centre[1], nC[2] - centre[2]];
    if (n[0] * -c[0] + n[1] * -c[1] + n[2] * -c[2] <= 0) continue;
    const [x, y] = project(P, W, H, c);
    plot(buf, W, H, x, y, [255, 50, 50], 1);
  }
  const M = fitJson.measure;
  const [ax, ay] = M.axisUp,
    px = -ay,
    py = ax,
    [cx, cy] = M.centroid;
  for (const s of fitJson.seamMeasured)
    plot(
      buf,
      W,
      H,
      cx + ax * s.s + px * s.off,
      cy + ay * s.s + py * s.off,
      [255, 230, 0],
      2,
    );
  await raw4(buf, W, H).png().toFile(file);
}

module.exports = { overlay };
