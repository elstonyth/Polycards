// SUPERSEDED 2026-11-24: public/images/slab-frame.webp is now a Blender render
// of a clear case (scripts/render-slab-case.py + scripts/compose-slab-case.mjs).
// Running this would put the old generated frosted frame back.
// One-off asset pipeline: turn a chroma-keyed slab-frame render (flat #FF00FF
// card window + background) into the transparent overlay the storefront ships
// as the DEFAULT frame (public/images/slab-frame.webp).
//
// Keying is magenta-ness based (min(R,B) - G), NOT global color-to-alpha:
// the AI render's magenta carries film grain, and color-to-alpha would also
// unmix magenta out of legitimately opaque art (it turned the gold label
// green). Non-key pixels stay byte-identical.
//
// Usage: node scripts/process-slab-frame.mjs [input.png]
//   SHARP_PATH=<dir> overrides where sharp is required from (fresh worktrees
//   have no backend node_modules yet).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const sharp = require(
  process.env.SHARP_PATH ??
    path.join(
      here,
      '..',
      'backend',
      'packages',
      'api',
      'node_modules',
      'sharp',
    ),
);

const input =
  process.argv[2] ??
  'C:/Users/PC/Downloads/Gemini_Generated_Image_le72cjle72cjle72.png';
const outWebp = path.join(here, '..', 'public', 'images', 'slab-frame.webp');
const outPreview = path.join(
  here,
  '..',
  'docs',
  'research',
  'slab-frame-preview.png',
);

const OUT_WIDTH = 800;
// keyness → alpha ramp: fully opaque at ≤ K0, fully transparent at ≥ K1.
const K0 = 0.15;
const K1 = 0.5;

const { data, info } = await sharp(input)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const { width: W, height: H } = info;
const px = (x, y) => (y * W + x) * 4;

// magenta-ness: R and B both elevated above G. 0 for whites/blacks/golds.
const keyness = (i) =>
  Math.max(0, Math.min(data[i], data[i + 2]) - data[i + 1]) / 255;

// --- 1. Card-window rect: walk out from the image center (inside the flat
// magenta window) until a run of ≥4 clearly non-magenta pixels — that's the
// plastic ridge. The window is rectangular, so a center cross is enough.
const isKey = (x, y) => keyness(px(x, y)) > 0.4;
const walk = (sx, sy, dx, dy) => {
  let x = sx,
    y = sy,
    run = 0,
    lastKey = { x: sx, y: sy };
  while (x >= 0 && x < W && y >= 0 && y < H) {
    if (isKey(x, y)) {
      run = 0;
      lastKey = { x, y };
    } else if (++run >= 4) return lastKey;
    x += dx;
    y += dy;
  }
  return lastKey;
};
const cx = W >> 1,
  cy = H >> 1;
if (!isKey(cx, cy))
  throw new Error('image center is not chroma-key magenta — wrong input?');
const win = {
  left: walk(cx, cy, -1, 0).x,
  right: walk(cx, cy, 1, 0).x,
  top: walk(cx, cy, 0, -1).y,
  bottom: walk(cx, cy, 0, 1).y,
};

// --- 2. Alpha from keyness + despill. Only pixels with magenta excess are
// touched: subtract the excess from R and B so semi-transparent plastic goes
// neutral grey instead of pink. Label/gold/white art has keyness 0.
const alpha = new Float32Array(W * H);
for (let n = 0; n < W * H; n++) {
  const i = n * 4;
  const k = keyness(i);
  alpha[n] = k >= K1 ? 0 : k <= K0 ? 1 : (K1 - k) / (K1 - K0);
  if (k > 0) {
    const excess = Math.min(data[i], data[i + 2]) - data[i + 1];
    data[i] -= excess;
    data[i + 2] -= excess;
  }
}

// --- 3. Speckle cleanup: the render's grain leaves isolated semi-opaque dots
// in the keyed-out field. Kill pixels whose 5×5 neighbourhood is mostly
// transparent — coherent slab regions are unaffected.
const cleaned = new Float32Array(alpha);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const n = y * W + x;
    if (alpha[n] === 0 || alpha[n] >= 0.85) continue;
    let sum = 0,
      cnt = 0;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx,
          yy = y + dy;
        if (xx < 0 || xx >= W || yy < 0 || yy >= H) continue;
        sum += alpha[yy * W + xx];
        cnt++;
      }
    if (sum / cnt < 0.25) cleaned[n] = 0;
  }
for (let n = 0; n < W * H; n++)
  data[n * 4 + 3] = Math.round(cleaned[n] * data[n * 4 + 3]);

// --- 4. Slab bounding box (alpha ≥ 25) → crop away the keyed-out margin.
let sl = W,
  sr = 0,
  st = H,
  sb = 0;
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++)
    if (data[px(x, y) + 3] >= 25) {
      if (x < sl) sl = x;
      if (x > sr) sr = x;
      if (y < st) st = y;
      if (y > sb) sb = y;
    }
const slabW = sr - sl + 1,
  slabH = sb - st + 1;

const cropped = sharp(data, {
  raw: { width: W, height: H, channels: 4 },
}).extract({ left: sl, top: st, width: slabW, height: slabH });
await cropped
  .clone()
  .resize({ width: OUT_WIDTH })
  .webp({ quality: 90, alphaQuality: 95 })
  .toFile(outWebp);
// eyeball preview: frame flattened over the site's neutral-900
await cropped
  .clone()
  .resize({ width: 500 })
  .flatten({ background: '#171717' })
  .png()
  .toFile(outPreview);

// --- 5. Window insets as % of the cropped slab — these go into SlabImage.
const pct = (v) => `${(v * 100).toFixed(2)}%`;
console.log(
  JSON.stringify(
    {
      out: outWebp,
      slab: { width: slabW, height: slabH, aspect: (slabW / slabH).toFixed(4) },
      windowInsets: {
        top: pct((win.top - st) / slabH),
        // Horizontal insets symmetrized to the LARGER side: these renders are
        // front-on and centered, but a walk can pierce the semi-transparent
        // plastic border on one side (keyness stays high through clear
        // plastic over magenta) and understate that inset.
        left: pct(Math.max(win.left - sl, sr - win.right) / slabW),
        right: pct(Math.max(win.left - sl, sr - win.right) / slabW),
        bottom: pct((sb - win.bottom) / slabH),
      },
    },
    null,
    2,
  ),
);
