// Remove the photo backdrop from every card asset (public/cdn/cards/*.webp) by
// turning border-connected background pixels transparent — the slab becomes a
// clean cutout, so the reveal's glow hugs the slab contour instead of showing a
// rectangle of slightly-off-black studio backdrop ("the black frame").
//
// Algorithm per image:
//   1. bg reference = median color of the border ring (handles dark studio
//      backdrops AND the white-bg scans).
//   2. BFS flood fill from all border pixels whose color is near the bg ref;
//      grow only through near-bg pixels → background mask (never reaches dark
//      areas INSIDE the slab because the bright plastic rim blocks the fill).
//   3. Morphological CLOSING of the keep-mask (dilate+erode, r=6) — heals any
//      thin leaks through dim slab corners so the slab is never eaten.
//   4. 1px feather on the matte edge (soft anti-aliased contour).
//   5. Save as webp with alpha (q92). Writes per-file metrics for QA.
//
// Run: node scripts/matte-card-backgrounds.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const DIR = path.resolve('public/cdn/cards');
const DRY = process.argv.includes('--dry');
const METRICS_OUT = path.resolve(
  'docs/research/clone-film/v2/matte-metrics.json',
);

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

async function matteOne(file) {
  const buf = fs.readFileSync(file);
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width,
    H = info.height,
    N = W * H;

  // --- 1. bg reference from the border ring ---
  const rs = [],
    gs = [],
    bs = [];
  const pushPx = (i) => {
    rs.push(data[i * 4]);
    gs.push(data[i * 4 + 1]);
    bs.push(data[i * 4 + 2]);
  };
  for (let x = 0; x < W; x++) {
    pushPx(x);
    pushPx((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    pushPx(y * W);
    pushPx(y * W + W - 1);
  }
  const bgR = median(rs),
    bgG = median(gs),
    bgB = median(bs);
  const bgLum = Math.max(bgR, bgG, bgB);
  // dark studio backdrop -> tight tolerance; white scan bg -> looser
  const TOL = bgLum < 80 ? 38 : 26;
  const isBg = (i) => {
    const r = data[i * 4],
      g = data[i * 4 + 1],
      b = data[i * 4 + 2];
    return (
      Math.abs(r - bgR) < TOL &&
      Math.abs(g - bgG) < TOL &&
      Math.abs(b - bgB) < TOL
    );
  };

  // --- 2. BFS from the border through near-bg pixels ---
  const bg = new Uint8Array(N); // 1 = background
  const queue = new Int32Array(N);
  let qh = 0,
    qt = 0;
  const seed = (i) => {
    if (!bg[i] && isBg(i)) {
      bg[i] = 1;
      queue[qt++] = i;
    }
  };
  for (let x = 0; x < W; x++) {
    seed(x);
    seed((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    seed(y * W);
    seed(y * W + W - 1);
  }
  while (qh < qt) {
    const i = queue[qh++];
    const x = i % W,
      y = (i / W) | 0;
    if (x > 0) seed(i - 1);
    if (x < W - 1) seed(i + 1);
    if (y > 0) seed(i - W);
    if (y < H - 1) seed(i + W);
  }

  // --- 3. closing on the KEEP mask (radius 6): dilate keep, then erode ---
  const R = 6;
  let keep = new Uint8Array(N);
  for (let i = 0; i < N; i++) keep[i] = bg[i] ? 0 : 1;
  const pass = (src, hit) => {
    // separable square dilation: out=1 if any src=hit within Chebyshev radius R
    const tmp = new Uint8Array(N),
      out = new Uint8Array(N);
    for (let y = 0; y < H; y++) {
      let run = 0;
      for (let x = 0; x < W + R; x++) {
        if (x < W && src[y * W + x] === hit) run = 2 * R + 1;
        const ox = x - R;
        if (ox >= 0 && ox < W) {
          tmp[y * W + ox] = run > 0 ? 1 : 0;
        }
        if (run > 0) run--;
      }
    }
    for (let x = 0; x < W; x++) {
      let run = 0;
      for (let y = 0; y < H + R; y++) {
        if (y < H && tmp[y * W + x] === 1) run = 2 * R + 1;
        const oy = y - R;
        if (oy >= 0 && oy < H) out[oy * W + x] = run > 0 ? 1 : 0;
        if (run > 0) run--;
      }
    }
    return out;
  };
  const dil = pass(keep, 1); // dilated keep
  const ero = pass(dil, 0); // dilate the complement = erode -> ero[i]=1 where complement-of-dil within R
  for (let i = 0; i < N; i++) keep[i] = ero[i] ? 0 : 1; // closed keep mask

  // --- 4. alpha = keep, feathered ~1px via 3x3 average at the boundary ---
  const alpha = new Uint8Array(N);
  for (let i = 0; i < N; i++) alpha[i] = keep[i] ? 255 : 0;
  const soft = new Uint8Array(N);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      let sum = 0,
        cnt = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx,
            ny = y + dy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
            sum += alpha[ny * W + nx];
            cnt++;
          }
        }
      soft[i] = Math.round(sum / cnt);
    }
  }
  for (let i = 0; i < N; i++) data[i * 4 + 3] = soft[i];

  // --- 5. metrics + save ---
  let transparent = 0,
    opaqueBorder = 0,
    interiorHoles = 0;
  for (let i = 0; i < N; i++) if (soft[i] < 16) transparent++;
  for (let x = 0; x < W; x++) {
    if (soft[x] > 128) opaqueBorder++;
    if (soft[(H - 1) * W + x] > 128) opaqueBorder++;
  }
  for (let y = 0; y < H; y++) {
    if (soft[y * W] > 128) opaqueBorder++;
    if (soft[y * W + W - 1] > 128) opaqueBorder++;
  }
  // interior holes = transparent pixels NOT in the flood bg (shouldn't exist after closing)
  for (let i = 0; i < N; i++)
    if (soft[i] < 16 && !bg[i] && keep[i]) interiorHoles++;

  if (!DRY) {
    const out = await sharp(Buffer.from(data.buffer), {
      raw: { width: W, height: H, channels: 4 },
    })
      .webp({ quality: 92 })
      .toBuffer();
    fs.writeFileSync(file, out);
  }
  return {
    file: path.basename(file),
    size: `${W}x${H}`,
    bg: `rgb(${bgR},${bgG},${bgB})`,
    transparentPct: +((transparent / N) * 100).toFixed(1),
    opaqueBorderPx: opaqueBorder,
    interiorHoles,
  };
}

const files = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.webp'))
  .map((f) => path.join(DIR, f));
const metrics = [];
let warn = 0;
for (const f of files) {
  const m = await matteOne(f);
  metrics.push(m);
  // sanity: a slab cutout should clear 15-60% of the frame and leave the border transparent
  const bad =
    m.transparentPct < 8 ||
    m.transparentPct > 70 ||
    m.opaqueBorderPx > 40 ||
    m.interiorHoles > 0;
  if (bad) warn++;
  console.log(
    `${bad ? 'WARN ' : 'ok   '}${m.file}  bg=${m.bg}  transparent=${m.transparentPct}%  opaqueBorder=${m.opaqueBorderPx}px  holes=${m.interiorHoles}`,
  );
}
fs.mkdirSync(path.dirname(METRICS_OUT), { recursive: true });
fs.writeFileSync(METRICS_OUT, JSON.stringify(metrics, null, 1));
console.log(
  `\n${files.length} files matted, ${warn} warnings${DRY ? ' (dry run)' : ''} — metrics: ${METRICS_OUT}`,
);
