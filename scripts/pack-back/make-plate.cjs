/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS node tool */
// Blank the live-text zones of a matched pack back, so the print module can draw
// the pack's current details there (src/components/pack-3d/pack-print.ts).
//
//   node scripts/pack-back/make-plate.cjs <pack>
//
// Reads <outDir>/<pack>-back-matched.png and the zones in
// <outDir>/<pack>-back-geometry.json (printZones), and writes
//   <pack>-back-plate.png          zones with plate "live" blanked
//   <pack>-back-plate-no-odds.png  those plus the "no-odds" zones (the fixed
//                                  odds heading), for a pack with no published odds
//
// Inside each zone the painted ink is found (bright text on dark foil, then
// whatever still stands above the rebuilt foil) and the foil under it is
// rebuilt by membrane interpolation (a Laplace solve from the surrounding foil,
// which is smooth gloss), plus a seeded grain matched to the foil's own fine
// texture. Deterministic: same inputs, same bytes.
//
// Checks (the run fails if any is broken):
//   a) alpha is byte-identical to the matched back
//   b) every pixel outside the zones (all the fixed wording, the gold outline,
//      the art) is unchanged, pixel for pixel
//   c) no ink is left: against a smoothed copy of the finished zone, no rebuilt pixel stands
//      out more than the untouched foil of the same zone does (+3 levels)
const fs = require('fs');
const path = require('path');
const {
  sharp,
  loadConfig,
  loadGeometry,
  zoneRects,
  inRects,
  rawRGBA,
} = require('./lib.cjs');

const pack = process.argv[2];
if (!pack)
  throw new Error('usage: node scripts/pack-back/make-plate.cjs <pack>');
const cfg = loadConfig(pack);
const P = {
  textThreshold: 92,
  residualThreshold: 7,
  dilate: 2,
  iterations: 600,
  grainSeed: 1,
  ...(cfg.plate || {}),
};
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// mulberry32: small seeded PRNG, so the grain is the same on every run
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rebuild one zone in place. img: Float32Array RGB of the whole image. */
function rebuildZone(img, W, H, rect, rand) {
  const ring = 2;
  const x0 = Math.max(0, rect.x0 - ring),
    x1 = Math.min(W, rect.x1 + ring);
  const y0 = Math.max(0, rect.y0 - ring),
    y1 = Math.min(H, rect.y1 + ring);
  const w = x1 - x0,
    h = y1 - y0;
  const at = (x, y) => ((y0 + y) * W + (x0 + x)) * 3;
  const inside = (x, y) =>
    x0 + x >= rect.x0 &&
    x0 + x < rect.x1 &&
    y0 + y >= rect.y0 &&
    y0 + y < rect.y1;
  const L = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = at(x, y);
      L[y * w + x] = lum(img[p], img[p + 1], img[p + 2]);
    }

  const dilate = (m, r) => {
    const o = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (!m[y * w + x]) continue;
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx,
              yy = y + dy;
            if (
              xx >= 0 &&
              xx < w &&
              yy >= 0 &&
              yy < h &&
              dx * dx + dy * dy <= r * r + r
            )
              o[yy * w + xx] = 1;
          }
      }
    // never outside the zone
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) if (!inside(x, y)) o[y * w + x] = 0;
    return o;
  };

  // membrane fill of the masked pixels: push-pull start, then SOR on the Laplace equation
  const fill = (mask) => {
    const out = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      const p = at(i % w, (i / w) | 0);
      for (let c = 0; c < 3; c++) out[i * 3 + c] = img[p + c];
    }
    // push-pull pyramid
    const levels = [];
    let lw = w,
      lh = h;
    let col = new Float32Array(w * h * 3),
      wt = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++)
      if (!mask[i]) {
        wt[i] = 1;
        for (let c = 0; c < 3; c++) col[i * 3 + c] = out[i * 3 + c];
      }
    levels.push({ lw, lh, col, wt });
    while (lw > 2 || lh > 2) {
      const nw = Math.ceil(lw / 2),
        nh = Math.ceil(lh / 2);
      const nc = new Float32Array(nw * nh * 3),
        nt = new Float32Array(nw * nh);
      for (let y = 0; y < lh; y++)
        for (let x = 0; x < lw; x++) {
          const s = y * lw + x,
            d = (y >> 1) * nw + (x >> 1);
          nt[d] += wt[s];
          for (let c = 0; c < 3; c++) nc[d * 3 + c] += col[s * 3 + c];
        }
      levels.push({ lw: nw, lh: nh, col: nc, wt: nt });
      lw = nw;
      lh = nh;
      col = nc;
      wt = nt;
    }
    for (let k = levels.length - 2; k >= 0; k--) {
      const f = levels[k],
        g = levels[k + 1];
      for (let y = 0; y < f.lh; y++)
        for (let x = 0; x < f.lw; x++) {
          const i = y * f.lw + x;
          if (f.wt[i] > 0) continue;
          const j = (y >> 1) * g.lw + (x >> 1);
          const gw = g.wt[j] || 1;
          for (let c = 0; c < 3; c++) f.col[i * 3 + c] = g.col[j * 3 + c] / gw;
          f.wt[i] = 1;
        }
      // normalise this level's known sums for the next finer one
      for (let i = 0; i < f.lw * f.lh; i++)
        if (f.wt[i] > 0 && f.wt[i] !== 1) {
          for (let c = 0; c < 3; c++) f.col[i * 3 + c] /= f.wt[i];
          f.wt[i] = 1;
        }
    }
    const top = levels[0];
    for (let i = 0; i < w * h; i++)
      if (mask[i])
        for (let c = 0; c < 3; c++)
          out[i * 3 + c] = top.col[i * 3 + c] / (top.wt[i] || 1);
    // SOR, red-black, masked pixels only
    const idx = [];
    for (let i = 0; i < w * h; i++) if (mask[i]) idx.push(i);
    const omega = 1.9;
    for (let it = 0; it < P.iterations; it++) {
      for (const parity of [0, 1]) {
        for (const i of idx) {
          const x = i % w,
            y = (i / w) | 0;
          if (((x + y) & 1) !== parity) continue;
          let n = 0;
          const s = [0, 0, 0];
          if (x > 0) {
            n++;
            for (let c = 0; c < 3; c++) s[c] += out[(i - 1) * 3 + c];
          }
          if (x < w - 1) {
            n++;
            for (let c = 0; c < 3; c++) s[c] += out[(i + 1) * 3 + c];
          }
          if (y > 0) {
            n++;
            for (let c = 0; c < 3; c++) s[c] += out[(i - w) * 3 + c];
          }
          if (y < h - 1) {
            n++;
            for (let c = 0; c < 3; c++) s[c] += out[(i + w) * 3 + c];
          }
          for (let c = 0; c < 3; c++)
            out[i * 3 + c] += omega * (s[c] / n - out[i * 3 + c]);
        }
      }
    }
    return out;
  };
  const lumOf = (buf, i) => lum(buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]);

  // a smooth foil estimate independent of the pixel itself: box mean (radius r) of a buffer's
  // luminance. The foil is soft gloss, so ink (and its antialiased edge) stands above it.
  const smoothLum = (getL, r) => {
    const t = new Float32Array(w * h),
      o = new Float32Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0,
          n = 0;
        for (let d = -r; d <= r; d++) {
          const xx = x + d;
          if (xx < 0 || xx >= w) continue;
          s += getL(y * w + xx);
          n++;
        }
        t[y * w + x] = s / n;
      }
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        let s = 0,
          n = 0;
        for (let d = -r; d <= r; d++) {
          const yy = y + d;
          if (yy < 0 || yy >= h) continue;
          s += t[yy * w + x];
          n++;
        }
        o[y * w + x] = s / n;
      }
    return o;
  };

  // pass 1: bright ink; passes 2-3: whatever still stands above a smoothed copy of the rebuilt
  // foil (antialiased edges, glow), so the mask grows by evidence, not only by dilation
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++)
    if (inside(i % w, (i / w) | 0) && L[i] > P.textThreshold) mask[i] = 1;
  mask = dilate(mask, 1);
  let bg = fill(mask);
  const grown = [];
  for (let pass = 0; pass < 2; pass++) {
    const m = new Uint8Array(mask);
    const sm = smoothLum((j) => lumOf(bg, j), 4);
    let added = 0;
    for (let i = 0; i < w * h; i++)
      if (
        inside(i % w, (i / w) | 0) &&
        !m[i] &&
        L[i] - sm[i] > P.residualThreshold
      ) {
        m[i] = 1;
        added++;
      }
    grown.push(added);
    mask = dilate(m, pass === 0 ? P.dilate : 1);
    bg = fill(mask);
  }

  // the foil's own fine texture: luminance minus its 3x3 mean, over unmasked zone pixels
  const hp = (get, i) => {
    const x = i % w,
      y = (i / w) | 0;
    let s = 0,
      n = 0;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx,
          yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        s += get(yy * w + xx);
        n++;
      }
    return get(i) - s / n;
  };
  let s2 = 0,
    n2 = 0;
  for (let i = 0; i < w * h; i++) {
    const x = i % w,
      y = (i / w) | 0;
    if (!inside(x, y) || mask[i]) continue;
    let near = false;
    for (let dy = -2; dy <= 2 && !near; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx,
          yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && mask[yy * w + xx]) {
          near = true;
          break;
        }
      }
    if (near) continue;
    const v = hp((j) => L[j], i);
    s2 += v * v;
    n2++;
  }
  const foilGrain = Math.sqrt(s2 / Math.max(1, n2));
  // seeded grain with the same 3x3 high-pass energy: white noise, softened by a [1 2 1] kernel
  const raw = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const u = Math.max(1e-9, rand()),
      v = rand();
    raw[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  const soft = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0,
        n = 0;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const k = (2 - Math.abs(dx)) * (2 - Math.abs(dy));
          s += raw[yy * w + xx] * k;
          n += k;
        }
      soft[y * w + x] = s / n;
    }
  let g2 = 0;
  for (let i = 0; i < w * h; i++) {
    const v = hp((j) => soft[j], i);
    g2 += v * v;
  }
  const gain = foilGrain / Math.sqrt(g2 / (w * h));

  let filled = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    filled++;
    const p = at(i % w, (i / w) | 0),
      n = soft[i] * gain;
    for (let c = 0; c < 3; c++) img[p + c] = bg[i * 3 + c] + n;
  }
  // check c: against an independent smooth estimate of the FINISHED zone, the rebuilt pixels may
  // stand out no more than the untouched foil pixels of the same zone do
  const outL = (j) => {
    const p = at(j % w, (j / w) | 0);
    return lum(img[p], img[p + 1], img[p + 2]);
  };
  const smOut = smoothLum(outL, 4);
  let worst = 0,
    foilWorst = 0;
  for (let i = 0; i < w * h; i++) {
    if (!inside(i % w, (i / w) | 0)) continue;
    const r = outL(i) - smOut[i];
    if (mask[i]) worst = Math.max(worst, r);
    else foilWorst = Math.max(foilWorst, r);
  }
  return { filled, foilGrain, worst, foilWorst, grown };
}

(async () => {
  const geo = loadGeometry(cfg);
  if (!geo?.printZones)
    throw new Error(`no printZones in ${cfg.name}-back-geometry.json`);
  const matchedFile = path.join(cfg.outDir, `${cfg.name}-back-matched.png`);
  const M = await rawRGBA(matchedFile);
  const { W, H } = M;
  for (const set of ['live', 'no-odds']) {
    const rects = zoneRects(geo, W, H, set);
    const img = new Float32Array(W * H * 3);
    for (let p = 0; p < W * H; p++)
      for (let c = 0; c < 3; c++) img[p * 3 + c] = M.data[p * 4 + c];
    const rand = prng(P.grainSeed);
    for (const r of rects) {
      const s = rebuildZone(img, W, H, r, rand);
      console.log(
        `${set}: zone ${r.id} cols ${r.x0}-${r.x1 - 1} rows ${r.y0}-${r.y1 - 1}: rebuilt ${s.filled} px, foil grain ${s.foilGrain.toFixed(2)}, mask grown by evidence +${s.grown.join('/+')} px; brightest rebuilt px ${s.worst.toFixed(2)} levels above the smoothed zone (untouched foil: ${s.foilWorst.toFixed(2)})`,
      );
      if (s.worst > s.foilWorst + 3)
        throw new Error(
          `ink left in zone ${r.id}: ${s.worst.toFixed(1)} levels above the foil`,
        );
    }
    const png = Buffer.alloc(W * H * 4);
    for (let p = 0; p < W * H; p++) {
      for (let c = 0; c < 3; c++)
        png[p * 4 + c] = Math.round(Math.max(0, Math.min(255, img[p * 3 + c])));
      png[p * 4 + 3] = M.data[p * 4 + 3];
    }
    const out = path.join(
      cfg.outDir,
      `${cfg.name}-back-plate${set === 'live' ? '' : '-no-odds'}.png`,
    );
    await sharp(png, { raw: { width: W, height: H, channels: 4 } })
      .png({ compressionLevel: 9 })
      .toFile(out);
    // checks a + b on the written file
    const chk = await rawRGBA(out);
    let aDiff = 0,
      fixedDiff = 0,
      fixed = 0,
      changedInside = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 4;
        if (chk.data[p + 3] !== M.data[p + 3]) aDiff++;
        const same =
          chk.data[p] === M.data[p] &&
          chk.data[p + 1] === M.data[p + 1] &&
          chk.data[p + 2] === M.data[p + 2];
        if (inRects(rects, x, y)) {
          if (!same) changedInside++;
          continue;
        }
        fixed++;
        if (!same) fixedDiff++;
      }
    if (aDiff > 0) throw new Error(`alpha differs in ${aDiff} px`);
    if (fixedDiff > 0)
      throw new Error(`fixed print changed in ${fixedDiff} px`);
    console.log(
      `${set}: wrote ${path.relative(process.cwd(), out)}; check: alpha mismatch ${aDiff} px; pixels outside the ${rects.length} zones ${fixed}, changed ${fixedDiff}; changed inside ${changedInside}`,
    );
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
