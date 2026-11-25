// SUPERSEDED 2026-11-24: public/images/slab-frame.webp is now a Blender render
// of a clear case (scripts/render-slab-case.py + scripts/compose-slab-case.mjs).
// Running this would put the old generated frosted frame back.
// Ship the graded-slab default frame + print its measured geometry
// (window insets, label box, holo probe).
//
// PROVENANCE (2026-07-17 operator correction, Task 2R): Task 2 shipped
// docs/research/slabframe-final-1600.png (approved 2026-07-16 in the label
// design session). The operator's FINAL pick — made 2026-07-17 in the
// tier-frame session (PR #196) — is docs/research/slabframe-user-1600.png:
// the case those tier bands were actually measured against. final-1600
// renders flat/featureless gray over the dark storefront; user-1600 is a
// textured/frosted realistic PSA case (molded rails, blue-tinted guilloche
// label, blank sticker) that keeps its texture on-page. Operator confirmed
// the swap 2026-07-17.
//
// user-1600 is ship-ready as-is: 1600x2700 PNG, transparent window +
// outside-background (verified corners alpha=0, border-connected flood at
// alpha<=8 finds a real transparent region, the card window is an unconnected
// interior transparent island), opaque-ish textured case (97.3% of
// non-transparent pixels sit at alpha>=128 — the sub-128 remainder is the
// case's own frosted-edge falloff, not a background halo), opaque blank
// label sticker (the dynamic grade text bakes onto it downstream). No chroma
// keying needed — this script just re-encodes to webp and measures.
//
// The old SnapGen-master lineage + --rebuild-from-master fallback (for
// final-1600) is retired: final-1600 is no longer shipped, so there is
// nothing to rebuild toward. If user-1600 is ever lost, re-pull it from the
// 2026-07-17 tier-frame session assets — there is no synthetic-geometry
// reconstruction for it (unlike final-1600, its alpha wasn't hand-painted
// from a raw SnapGen render).
//
// Usage: node scripts/process-slabframe-v2.mjs
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '..', 'package.json'));
const sharp = require(process.env.SHARP_PATH ?? 'sharp');

const SRC = path.join(
  here,
  '..',
  'docs',
  'research',
  'slabframe-user-1600.png',
);
const OUT = path.join(here, '..', 'public', 'images', 'slab-frame.webp');
const TARGET_W = 1600; // = MAX_FRAME_WIDTH in bake-slab.ts
const TARGET_H = 2700;

// ---- 1. load + sanity-check the source ----
const { data, info } = await sharp(SRC)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const W = info.width,
  H = info.height,
  CH = info.channels;
if (W !== TARGET_W || H !== TARGET_H) {
  throw new Error(`expected the ${TARGET_W}x${TARGET_H} source, got ${W}x${H}`);
}
const A = (x, y) => data[(y * W + x) * CH + 3];

// the 4 true corners must be transparent — the case is a rounded-rect that
// nearly fills the canvas, so only the rounded-off corners are real
// "outside background" (unlike the old glassy frame, there is no margin).
for (const [cx, cy] of [
  [0, 0],
  [W - 1, 0],
  [0, H - 1],
  [W - 1, H - 1],
]) {
  if (A(cx, cy) > 8) {
    throw new Error(
      `corner (${cx},${cy}) is not transparent (alpha ${A(cx, cy)})`,
    );
  }
}
// border-connected flood at alpha<=8 must find a real transparent region —
// if it finds ~0 pixels, the "background" is actually opaque and needs keying.
const ext = new Uint8Array(W * H);
{
  const st = [];
  for (let x = 0; x < W; x++) st.push(x, 0, x, H - 1);
  for (let y = 0; y < H; y++) st.push(0, y, W - 1, y);
  while (st.length) {
    const y = st.pop(),
      x = st.pop();
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const p = y * W + x;
    if (ext[p] || A(x, y) > 8) continue;
    ext[p] = 1;
    st.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
  }
}
let floodCount = 0;
for (let p = 0; p < W * H; p++) floodCount += ext[p];
if (floodCount < 100) {
  throw new Error(
    `BLOCKED: border-connected transparent flood found only ${floodCount} px — ` +
      'background is not genuinely transparent, needs keying',
  );
}
// case substantially opaque: of all non-background (alpha>8) pixels, most
// should sit at alpha>=128 (textured/frosted case + opaque label).
let nonBg = 0,
  substantial = 0,
  opaqueGt240 = 0;
for (let p = 0; p < W * H; p++) {
  const a = data[p * CH + 3];
  if (a > 8) {
    nonBg++;
    if (a >= 128) substantial++;
    if (a > 240) opaqueGt240++;
  }
}
const substantialFrac = substantial / nonBg;
if (substantialFrac < 0.85) {
  throw new Error(
    `case not substantially opaque: only ${(substantialFrac * 100).toFixed(1)}% ` +
      'of non-background pixels are alpha>=128',
  );
}
if (opaqueGt240 < W * H * 0.05) {
  throw new Error(
    `opaque label region missing: only ${opaqueGt240} px at alpha>240`,
  );
}
console.log('alpha histogram (16-wide buckets, 0-255):');
{
  const hist = new Array(17).fill(0);
  for (let p = 0; p < W * H; p++) hist[Math.floor(data[p * CH + 3] / 16)]++;
  hist.forEach((c, i) =>
    console.log(
      `  [${i * 16}-${i * 16 + 15}]`,
      c,
      `${((c / (W * H)) * 100).toFixed(2)}%`,
    ),
  );
}
console.log(
  'border-connected transparent flood:',
  floodCount,
  ' non-background px:',
  nonBg,
  ` (${(substantialFrac * 100).toFixed(1)}% alpha>=128, ${((opaqueGt240 / (W * H)) * 100).toFixed(1)}% alpha>240 of whole frame)`,
);

// ---- 2. ship ----
await sharp(data, { raw: { width: W, height: H, channels: CH } })
  .webp({ quality: 90, alphaQuality: 90 })
  .toFile(OUT);

// ---- 3. verify the webp encode kept the alpha mask (transparent-vs-not) ----
{
  const { data: D2 } = await sharp(OUT)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let mismatch = 0;
  for (let p = 0; p < W * H; p++) {
    if (data[p * CH + 3] <= 8 !== D2[p * CH + 3] <= 8) mismatch++;
  }
  console.log(
    'webp alpha-mask mismatch vs source:',
    mismatch,
    `(${((mismatch / (W * H)) * 100).toFixed(4)}%)`,
  );
  if (mismatch > W * H * 0.003) {
    throw new Error('webp encode perturbed the alpha mask beyond tolerance');
  }
}

// ---- 4. measure the shipped frame (never eyeball — §5) ----
const { data: D, info: I } = await sharp(OUT)
  .ensureAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });
const w = I.width,
  h = I.height,
  ch = I.channels;
const A2 = (x, y) => D[(y * w + x) * ch + 3];
const RGB = (x, y) => {
  const i = (y * w + x) * ch;
  return [D[i], D[i + 1], D[i + 2]];
};
// exterior flood (transparent + border-connected), then window = interior transparent bbox
const ext2 = new Uint8Array(w * h);
const st2 = [];
for (let x = 0; x < w; x++) st2.push(x, 0, x, h - 1);
for (let y = 0; y < h; y++) st2.push(0, y, w - 1, y);
while (st2.length) {
  const y = st2.pop(),
    x = st2.pop();
  if (x < 0 || y < 0 || x >= w || y >= h) continue;
  const p = y * w + x;
  if (ext2[p] || A2(x, y) > 8) continue;
  ext2[p] = 1;
  st2.push(x + 1, y, x - 1, y, x, y + 1, x, y - 1);
}
let wx0 = w,
  wy0 = h,
  wx1 = -1,
  wy1 = -1;
for (let y = 0; y < h; y++)
  for (let x = 0; x < w; x++) {
    if (A2(x, y) <= 8 && !ext2[y * w + x]) {
      if (x < wx0) wx0 = x;
      if (x > wx1) wx1 = x;
      if (y < wy0) wy0 = y;
      if (y > wy1) wy1 = y;
    }
  }
console.log('frame', `${w}x${h}`, 'SLAB_ASPECT', (w / h).toFixed(4));
console.log(
  'SLAB_WINDOW  top',
  (wy0 / h).toFixed(4),
  ' left',
  (wx0 / w).toFixed(4),
  ' right',
  ((w - 1 - wx1) / w).toFixed(4),
  ' bottom',
  ((h - 1 - wy1) / h).toFixed(4),
  ' window aspect',
  ((wx1 - wx0) / (wy1 - wy0)).toFixed(4),
);
// label = the WHITE STICKER inside the red border, top 20% of the frame.
// NOT the red outer bbox: all text constants are fractions of the sticker
// (measured 2026-07-16 on 4 real cert labels incl. cert 152108321 — the same
// Pikachu ex #238; using the red bbox pushed the right column outside the
// label). Off-centre scanlines so neither the border's rounded corners nor
// the centred PSA logo can truncate the walk.
const isRedAt = (x, y) => {
  const [r, g, b] = RGB(x, y);
  return A2(x, y) > 200 && r > 140 && g < 90 && b < 90;
};
let lx0 = w,
  ly0 = h,
  lx1 = -1,
  ly1 = -1;
for (let y = 0; y < Math.floor(h * 0.2); y++)
  for (let x = 0; x < w; x++) {
    if (isRedAt(x, y)) {
      if (x < lx0) lx0 = x;
      if (x > lx1) lx1 = x;
      if (y < ly0) ly0 = y;
      if (y > ly1) ly1 = y;
    }
  }
const rowY = Math.round(ly0 + (ly1 - ly0) * 0.3); // crosses text at worst, never the logo
let sx0 = Math.round((lx0 + lx1) / 2);
while (sx0 > lx0 && !isRedAt(sx0 - 1, rowY)) sx0--;
let sx1 = Math.round((lx0 + lx1) / 2);
while (sx1 < lx1 && !isRedAt(sx1 + 1, rowY)) sx1++;
const colX = Math.round(lx0 + (lx1 - lx0) * 0.15); // left of the centred PSA logo
let sy0 = Math.round((ly0 + ly1) / 2);
while (sy0 > ly0 && !isRedAt(colX, sy0 - 1)) sy0--;
let sy1 = Math.round((ly0 + ly1) / 2);
while (sy1 < ly1 && !isRedAt(colX, sy1 + 1)) sy1++;
const STICKER = { x: sx0, y: sy0, w: sx1 - sx0 + 1, h: sy1 - sy0 + 1 };
console.log(
  'LABEL_BOX (white sticker)  top',
  (STICKER.y / h).toFixed(4),
  ' left',
  (STICKER.x / w).toFixed(4),
  ' right',
  ((w - STICKER.x - STICKER.w) / w).toFixed(4),
  ' height',
  (STICKER.h / h).toFixed(4),
);
// holo probe: the frame's baked-in PSA logo — dark ink bands inside the
// sticker (§13; text rows must stay above its top edge)
let hy0 = -1;
for (let y = sy0 + Math.floor(STICKER.h * 0.5); y <= sy1 && hy0 < 0; y++) {
  for (let x = sx0 + 3; x < sx1 - 3; x++) {
    const [r, g, b] = RGB(x, y);
    if (A2(x, y) > 200 && Math.max(r, g, b) < 190) {
      hy0 = y;
      break;
    }
  }
}
if (hy0 >= 0) {
  const holoFrac = (hy0 - sy0) / STICKER.h;
  console.log(
    'HOLO/logo top  frac-of-sticker',
    holoFrac.toFixed(3),
    '(text baseline 3 sits at 0.723 — must be ABOVE this)',
  );
  if (holoFrac <= 0.75) {
    throw new Error(
      `STOP: holo/logo top fraction ${holoFrac.toFixed(3)} <= 0.75 — text baseline 3 ` +
        '(0.723) would collide with the logo',
    );
  }
} else {
  console.log(
    'HOLO probe: no logo ink found in the sticker bottom half — inspect manually',
  );
}
