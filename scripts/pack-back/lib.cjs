/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS node tool */
// Shared helpers for the pack-back tools (match-back, pair-sheet, make-plate).
// Run from the repo root: `node scripts/pack-back/<tool>.cjs <pack>`.
//
// A pack's config is scripts/pack-back/packs/<pack>.json. Relative paths in it
// resolve against the repo root; absolute paths are used as they are (the
// finished front art still lives in the main checkout's docs/research, which
// is gitignored, so worktrees read it from there). `workDir` (intermediate
// files) defaults to <os tmp>/pack-back/<pack>.
const path = require('path');
const fs = require('fs');
const os = require('os');

const REPO = path.resolve(__dirname, '..', '..');
const sharp = require(path.join(REPO, 'node_modules', 'sharp'));

function loadConfig(pack) {
  const p = path.join(__dirname, 'packs', `${pack}.json`);
  if (!fs.existsSync(p))
    throw new Error(`no config for pack "${pack}" at ${p}`);
  const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
  const abs = (f) =>
    f == null ? f : path.isAbsolute(f) ? f : path.join(REPO, f);
  for (const k of ['front', 'frontWebp', 'backRef', 'backRaw', 'outDir'])
    cfg[k] = abs(cfg[k]);
  if (cfg.strip?.grain?.source)
    cfg.strip.grain.source = abs(cfg.strip.grain.source);
  cfg.workDir = cfg.workDir
    ? abs(cfg.workDir)
    : path.join(os.tmpdir(), 'pack-back', cfg.name);
  return cfg;
}

/** The pack's geometry JSON (<outDir>/<pack>-back-geometry.json), or null. */
function loadGeometry(cfg) {
  const p = path.join(cfg.outDir, `${cfg.name}-back-geometry.json`);
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

/**
 * The geometry's dynamic print zones as integer pixel rectangles, half-open:
 * columns [x0, x1), rows [y0, y1). `set` picks which zones: 'live' (the zones
 * the live text replaces) or 'no-odds' (those plus the ones blanked only when a
 * pack has no pull odds).
 */
function zoneRects(geo, W, H, set = 'live') {
  const zones = geo?.printZones?.zones ?? [];
  return zones
    .filter((z) => set === 'no-odds' || !z.plate || z.plate === 'live')
    .map((z) => ({
      id: z.id,
      x0: Math.round(z.rect.x0 * W),
      x1: Math.round(z.rect.x1 * W),
      y0: Math.round(z.rect.y0 * H),
      y1: Math.round(z.rect.y1 * H),
    }));
}

const inRects = (rects, x, y) =>
  rects.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);

async function rawRGBA(file, { flop = false } = {}) {
  let img = sharp(file);
  if (flop) img = img.flop();
  const { data, info } = await img
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height };
}

async function rawRGB(file) {
  const { data, info } = await sharp(file)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, W: info.width, H: info.height };
}

// sRGB 0..255 <-> CIE Lab (D65)
const toLin = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const LIN = new Float64Array(256);
for (let i = 0; i < 256; i++) LIN[i] = toLin(i);
const fromLin = (c) => {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, v * 255));
};
const fxyz = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const ifxyz = (t) => {
  const t3 = t * t * t;
  return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787;
};
function rgb2lab(r, g, b) {
  const R = LIN[r | 0],
    G = LIN[g | 0],
    B = LIN[b | 0];
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047;
  const y = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  const z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const fx = fxyz(x),
    fy = fxyz(y),
    fz = fxyz(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function lab2rgb(L, a, b) {
  const fy = (L + 16) / 116,
    fx = fy + a / 500,
    fz = fy - b / 200;
  const x = ifxyz(fx) * 0.95047,
    y = ifxyz(fy),
    z = ifxyz(fz) * 1.08883;
  const R = 3.2406 * x - 1.5372 * y - 0.4986 * z;
  const G = -0.9689 * x + 1.8758 * y + 0.0415 * z;
  const B = 0.0557 * x - 0.204 * y + 1.057 * z;
  return [fromLin(R), fromLin(G), fromLin(B)];
}

// Per-row subpixel extents of alpha >= thr (null when the row is empty).
function alphaExtents(rgba, W, H, thr = 128) {
  const L = new Array(H).fill(null),
    R = new Array(H).fill(null);
  for (let y = 0; y < H; y++) {
    let l = -1,
      r = -1;
    for (let x = 0; x < W; x++)
      if (rgba[(y * W + x) * 4 + 3] >= thr) {
        l = x;
        break;
      }
    if (l < 0) continue;
    for (let x = W - 1; x >= 0; x--)
      if (rgba[(y * W + x) * 4 + 3] >= thr) {
        r = x;
        break;
      }
    const a = (x) => rgba[(y * W + x) * 4 + 3];
    const lp = l > 0 ? l - (a(l) - thr) / Math.max(1, a(l) - a(l - 1)) : l;
    const rp = r < W - 1 ? r + (a(r) - thr) / Math.max(1, a(r) - a(r + 1)) : r;
    L[y] = lp;
    R[y] = rp;
  }
  return { L, R };
}

function median(arr) {
  const s = arr.filter((v) => v != null).sort((a, b) => a - b);
  return s.length ? s[s.length >> 1] : null;
}
function smooth(arr, rad, fn = 'mean') {
  return arr.map((v, i) => {
    if (v == null) return null;
    const w = [];
    for (let j = i - rad; j <= i + rad; j++)
      if (j >= 0 && j < arr.length && arr[j] != null) w.push(arr[j]);
    return fn === 'median'
      ? median(w)
      : w.reduce((a, b) => a + b, 0) / w.length;
  });
}

module.exports = {
  REPO,
  sharp,
  loadConfig,
  loadGeometry,
  zoneRects,
  inRects,
  rawRGBA,
  rawRGB,
  rgb2lab,
  lab2rgb,
  alphaExtents,
  median,
  smooth,
};
