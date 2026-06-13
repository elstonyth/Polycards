// Remediate the card cutouts flagged by the visual-QA pass. Runs on files
// RESTORED FROM GIT HEAD (pre-matte bytes). Handles the failure modes found:
//   - small-format pedestal photos (h-007/8/9/10/12): the slab's reflection on
//     the pedestal bridged the dark gap, so the first crop kept the pedestal ->
//     bottom-up pedestal detection (median-luminance gap) crops it off first
//   - light/white backdrops + dark vignette rings (h-002, h-043): a single
//     border-median bg ref can't cover both -> DUAL-mode refs (dark + light
//     border clusters), flood with each
//   - residue blobs / detached line segments (h-031, h-040): keep only the
//     LARGEST connected opaque component after closing
//   - per-file TOL/closing overrides where the defaults leaked or over-kept
//
// Run: node scripts/matte-fix-flagged.mjs
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const DIR = path.resolve('public/cdn/cards');
// v2 configs, derived from measured row profiles + the v1 failure analysis:
// - the 237x430 pedestal batch: slab rim ends ~y330, pedestal top ~y345 (the
//   "gap" is polluted by the slab's reflection) -> fixed crop at 0.78*H
// - refsMode "dark": NEVER flood with the light border cluster — on tight crops
//   it is the slab's own plastic rim and eats the slab (v1's h-031/40/43 bug)
// - h-043 (light-grey scan): dark vignette ref + an EXPLICIT bg sample from the
//   top-center margin, tight tolerance so the grey plastic rim blocks the flood
const CFG = {
  // h-002 / h-031 / h-040 / h-043 intentionally absent — already fixed.
  // Crop rows are MEASURED per file (median-luminance dark-run profiles): these
  // slabs end with a clear-plastic section (~y337-341, reads dark) + a bottom
  // edge highlight (~y342-355); the true slab/pedestal gap is y356-361 — the
  // earlier 0.78*H crop (y335) cut the slab bottom off.
  'h-007': { cropBottomPx: 358, refsMode: 'dark', close: 6 },
  'h-008': { cropBottomPx: 358, refsMode: 'dark', close: 6 },
  'h-009': { cropBottomPx: 360, refsMode: 'dark', close: 6 },
  'h-010': { cropBottomPx: 358, refsMode: 'dark', close: 6 },
  'h-012': { cropBottomPx: 359, refsMode: 'dark', close: 6 },
};

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

// ---- fixed-fraction bottom crop (template-measured, see CFG comment) ----
async function cropBottomFrac(buf, frac) {
  const { width: W, height: H } = await sharp(buf).metadata();
  return sharp(buf)
    .extract({ left: 0, top: 0, width: W, height: Math.round(H * frac) })
    .toBuffer();
}

// ---- matte v2: dual-ref flood + closing + largest-component + feather ----
async function matte(buf, { tol, close = 6, refsMode = 'dark', point } = {}) {
  const cfgRefsMode = refsMode,
    cfgPoint = point;
  const { data, info } = await sharp(buf)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const W = info.width,
    H = info.height,
    N = W * H;

  // border pixels -> split into dark/light luminance clusters
  const border = [];
  const push = (i) => border.push(i);
  for (let x = 0; x < W; x++) {
    push(x);
    push((H - 1) * W + x);
  }
  for (let y = 0; y < H; y++) {
    push(y * W);
    push(y * W + W - 1);
  }
  const lumOf = (i) => Math.max(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  const refFor = (idxs) => {
    if (!idxs.length) return null;
    const r = median(idxs.map((i) => data[i * 4]));
    const g = median(idxs.map((i) => data[i * 4 + 1]));
    const b = median(idxs.map((i) => data[i * 4 + 2]));
    return { r, g, b, lum: Math.max(r, g, b) };
  };
  const lums = border.map(lumOf);
  const mid = (Math.min(...lums) + Math.max(...lums)) / 2;
  const refs = [];
  // "dark": only the darker border cluster — the light cluster on tight crops is
  // the slab's own rim and must never seed the flood
  refs.push(refFor(border.filter((i, k) => lums[k] <= mid)));
  if (cfgRefsMode === 'darkPlusPoint' && cfgPoint) {
    const px = Math.round(W * cfgPoint[0]),
      py = Math.round(H * cfgPoint[1]);
    const idxs = [];
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const x = px + dx,
          y = py + dy;
        if (x >= 0 && x < W && y >= 0 && y < H) idxs.push(y * W + x);
      }
    refs.push(refFor(idxs));
  }
  const tolFor = (ref) => tol ?? (ref.lum < 80 ? 38 : 26);
  const near = (i, ref, t) =>
    Math.abs(data[i * 4] - ref.r) < t &&
    Math.abs(data[i * 4 + 1] - ref.g) < t &&
    Math.abs(data[i * 4 + 2] - ref.b) < t;

  // flood per ref, union
  const bg = new Uint8Array(N);
  const queue = new Int32Array(N);
  for (const ref of refs.filter(Boolean)) {
    const t = tolFor(ref);
    let qh = 0,
      qt = 0;
    const seed = (i) => {
      if (!bg[i] && near(i, ref, t)) {
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
  }

  // closing on keep (separable Chebyshev dilate/erode, radius = close)
  const R = close;
  let keep = new Uint8Array(N);
  for (let i = 0; i < N; i++) keep[i] = bg[i] ? 0 : 1;
  const pass = (src, hit) => {
    const tmp = new Uint8Array(N),
      out = new Uint8Array(N);
    for (let y = 0; y < H; y++) {
      let run = 0;
      for (let x = 0; x < W + R; x++) {
        if (x < W && src[y * W + x] === hit) run = 2 * R + 1;
        const ox = x - R;
        if (ox >= 0 && ox < W) tmp[y * W + ox] = run > 0 ? 1 : 0;
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
  if (R > 0) {
    const dil = pass(keep, 1);
    const ero = pass(dil, 0);
    for (let i = 0; i < N; i++) keep[i] = ero[i] ? 0 : 1;
  }

  // largest connected component only (sweeps detached residue blobs/segments)
  const comp = new Int32Array(N).fill(-1);
  let best = -1,
    bestSize = 0,
    nComp = 0;
  for (let s = 0; s < N; s++) {
    if (!keep[s] || comp[s] !== -1) continue;
    let qh = 0,
      qt = 0,
      size = 0;
    queue[qt++] = s;
    comp[s] = nComp;
    while (qh < qt) {
      const i = queue[qh++];
      size++;
      const x = i % W,
        y = (i / W) | 0;
      const tryN = (j) => {
        if (keep[j] && comp[j] === -1) {
          comp[j] = nComp;
          queue[qt++] = j;
        }
      };
      if (x > 0) tryN(i - 1);
      if (x < W - 1) tryN(i + 1);
      if (y > 0) tryN(i - W);
      if (y < H - 1) tryN(i + W);
    }
    if (size > bestSize) {
      bestSize = size;
      best = nComp;
    }
    nComp++;
  }
  for (let i = 0; i < N; i++) if (keep[i] && comp[i] !== best) keep[i] = 0;

  // feather ~1px + write alpha
  const alpha = new Uint8Array(N);
  for (let i = 0; i < N; i++) alpha[i] = keep[i] ? 255 : 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
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
      data[(y * W + x) * 4 + 3] = Math.round(sum / cnt);
    }
  }
  const out = await sharp(Buffer.from(data.buffer), {
    raw: { width: W, height: H, channels: 4 },
  })
    .webp({ quality: 92 })
    .toBuffer();
  const transparent = (() => {
    let n = 0;
    for (let i = 0; i < N; i++) if (data[i * 4 + 3] < 16) n++;
    return n;
  })();
  return {
    out,
    W,
    H,
    transparentPct: +((transparent / N) * 100).toFixed(1),
    components: nComp,
    refs: refs.filter(Boolean).map((r) => `rgb(${r.r},${r.g},${r.b})`),
  };
}

for (const [name, cfg] of Object.entries(CFG)) {
  const file = path.join(DIR, `${name}.webp`);
  let buf = fs.readFileSync(file);
  let note = '';
  if (cfg.cropBottomFrac || cfg.cropBottomPx) {
    const before = (await sharp(buf).metadata()).height;
    buf = cfg.cropBottomPx
      ? await (async () => {
          const { width: W } = await sharp(buf).metadata();
          return sharp(buf)
            .extract({ left: 0, top: 0, width: W, height: cfg.cropBottomPx })
            .toBuffer();
        })()
      : await cropBottomFrac(buf, cfg.cropBottomFrac);
    const after = (await sharp(buf).metadata()).height;
    note = `pedestal cropped (${before}->${after}px)`;
  }
  const m = await matte(buf, cfg);
  fs.writeFileSync(file, m.out);
  console.log(
    `${name}: ${m.W}x${m.H} transparent=${m.transparentPct}% comps=${m.components} refs=[${m.refs}] ${note}`,
  );
}
console.log('done');
