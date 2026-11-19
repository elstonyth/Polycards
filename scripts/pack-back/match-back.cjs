/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS node tool */
// Fit a generated pack BACK to its finished FRONT so the 3D pack reads as one object.
//
//   node scripts/pack-back/match-back.cjs <pack> [seamMode] [--final]
//     pack      name of scripts/pack-back/packs/<pack>.json
//     seamMode  crimp | recolour | gold   (default: config seamMode)
//     --final   also write <outDir>/<pack>-back-matched.png and <pack>-back-geometry.json
//
// Steps (all on raw RGBA buffers, no sharp compositing so alpha bytes stay exact):
//  1. outline   alpha = the front's alpha mirrored left-right, byte for byte
//  2. body      the back's printed body (between its crimps) is warped into the front's body:
//               text rows are copied 1:1 (integer shift, zero resampling); only the text-free
//               shoulder bands above/below the print stretch, and only the outer foil columns
//               squeeze, so the back's own edge follows the front's silhouette
//  3. seam      fin seal re-skinned with the front's crimp foil (or recoloured / kept gold)
//  4. strip     unprinted edge foil strip recoloured with the front's foil colours
//  5. rim       the mirrored front's outer rim blended in, so both faces share their edge
//  6. crimps    the front's own crimp bands, mirrored, pasted at full strength with a short feather
const fs = require('fs');
const path = require('path');
const {
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
} = require('./lib.cjs');

const args = process.argv.slice(2);
const pack = args.find((a) => !a.startsWith('--'));
if (!pack)
  throw new Error(
    'usage: node match-back.cjs <pack> [crimp|recolour|gold] [--final]',
  );
const cfg = loadConfig(pack);
const seamMode = args.filter((a) => !a.startsWith('--'))[1] || cfg.seamMode;
const FINAL = args.includes('--final');
const bk = cfg.back;
fs.mkdirSync(cfg.workDir, { recursive: true });

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

(async () => {
  const F = await rawRGBA(cfg.front, { flop: true }); // mirrored front = what the back must coincide with
  const B = await rawRGB(cfg.backRef);
  const { W, H } = F;
  if (B.W !== W || B.H !== H)
    throw new Error(`size mismatch front ${W}x${H} back ${B.W}x${B.H}`);
  const Fd = F.data,
    Bd = B.data;

  // ---- 1. front silhouette and crimp rows -------------------------------------------------
  const ext = alphaExtents(Fd, W, H, 128);
  const rows = ext.L.map((v, y) => (v == null ? -1 : y)).filter((y) => y >= 0);
  const y0 = rows[0],
    y1 = rows[rows.length - 1];
  const cl = median(ext.L.slice(y0 + 8, y0 + 60)),
    cr = median(ext.R.slice(y0 + 8, y0 + 60));
  const clb = median(ext.L.slice(y1 - 60, y1 - 8)),
    crb = median(ext.R.slice(y1 - 60, y1 - 8));
  const inset = (y, l, r) => (ext.L[y] - l + (r - ext.R[y])) / 2;
  let Ct = y0 + 20;
  while (inset(Ct, cl, cr) < 2.5) Ct++;
  let Cb = y1 - 20;
  while (inset(Cb, clb, crb) < 2.5) Cb--;
  const mL = smooth(ext.L, 3),
    mR = smooth(ext.R, 3);
  console.log(
    `front: rows ${y0}-${y1}, crimp top ${y0}-${Ct}, bottom ${Cb}-${y1}`,
  );

  // ---- back edges (backRef is on black) ---------------------------------------------------
  const bl0 = new Array(H).fill(null),
    br0 = new Array(H).fill(null);
  for (let y = 0; y < H; y++) {
    const on = (x) => {
      const i = (y * W + x) * 3;
      return Math.max(Bd[i], Bd[i + 1], Bd[i + 2]) > bk.edgeThreshold;
    };
    let l = -1,
      r = -1;
    for (let x = 0; x < W; x++)
      if (on(x)) {
        l = x;
        break;
      }
    for (let x = W - 1; x >= 0; x--)
      if (on(x)) {
        r = x;
        break;
      }
    if (l >= 0) {
      bl0[y] = l;
      br0[y] = r;
    }
  }
  const bL = smooth(smooth(bl0, 7, 'median'), 4),
    bR = smooth(smooth(br0, 7, 'median'), 4);
  const bAt = (arr, ya) => {
    const a = Math.floor(ya),
      t = ya - a;
    const v0 = arr[clamp(a, 0, H - 1)],
      v1 = arr[clamp(a + 1, 0, H - 1)];
    return lerp(v0 ?? v1, v1 ?? v0, t);
  };

  // ---- 2. vertical map: output row -> backRef row ----------------------------------------
  const T0 = bk.textTop,
    T1 = bk.textBottom,
    bT = bk.bodyTop,
    bB = bk.bodyBottom;
  const dy = Math.round(
    ((Cb - T1) * (T0 - bT) - (T0 - Ct) * (bB - T1)) / (bB - T1 + (T0 - bT)),
  );
  const sT = (T0 + dy - Ct) / (T0 - bT),
    sB = (Cb - T1 - dy) / (bB - T1);
  const vmap = (Y) =>
    Y < T0 + dy
      ? bT + (Y - Ct) / sT
      : Y > T1 + dy
        ? T1 + (Y - (T1 + dy)) / sB
        : Y - dy;
  console.log(
    `vertical: text rows shift dy=${dy} (1:1), top band x${sT.toFixed(3)}, bottom band x${sB.toFixed(3)}`,
  );

  // ---- horizontal offset (integer) so text columns copy 1:1 -------------------------------
  const offs = [];
  for (let Y = T0 + dy; Y <= T1 + dy; Y += 4) {
    const ya = Y - dy;
    offs.push((mL[Y] + mR[Y]) / 2 - (bL[ya] + bR[ya]) / 2);
  }
  const off = Math.round(median(offs));
  const xL = bk.xL,
    xR = bk.xR,
    ins = bk.inset;
  console.log(
    `horizontal: text columns shift off=${off} (1:1); outer foil columns <${xL + off} and >${xR + off} remapped`,
  );

  const hmap = (X, Y, ya) => {
    const ml = mL[Y],
      mr = mR[Y];
    if (X < xL + off) {
      const bl = bAt(bL, ya) + ins;
      return bl + ((X - ml) * (xL - bl)) / (xL + off - ml);
    }
    if (X > xR + off) {
      const br = bAt(bR, ya) - ins;
      return xR + ((X - (xR + off)) * (br - xR)) / (mr - (xR + off));
    }
    return X - off;
  };
  const sampleB = (x, y) => {
    x = clamp(x, 0, W - 1);
    y = clamp(y, 0, H - 1);
    const x0 = Math.floor(x),
      y0_ = Math.floor(y),
      x1 = Math.min(W - 1, x0 + 1),
      y1_ = Math.min(H - 1, y0_ + 1);
    const tx = x - x0,
      ty = y - y0_;
    const o = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = Bd[(y0_ * W + x0) * 3 + c],
        b = Bd[(y0_ * W + x1) * 3 + c],
        d = Bd[(y1_ * W + x0) * 3 + c],
        e = Bd[(y1_ * W + x1) * 3 + c];
      o[c] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
    }
    return o;
  };

  // out RGB starts as the mirrored front everywhere (crimps, transparent background)
  const out = new Float32Array(W * H * 3);
  for (let p = 0; p < W * H; p++)
    for (let c = 0; c < 3; c++) out[p * 3 + c] = Fd[p * 4 + c];
  const base = new Float32Array(W * H * 3); // pure warp, kept for the print-unchanged proof
  const yA = Math.max(y0, Ct - 14),
    yZ = Math.min(y1, Cb + 14);
  const XA = new Float32Array(W * H).fill(NaN),
    YA = new Float32Array(H).fill(NaN);
  for (let Y = yA; Y <= yZ; Y++) {
    if (mL[Y] == null) continue;
    const ya = vmap(Y);
    YA[Y] = ya;
    for (let X = 0; X < W; X++) {
      if (Fd[(Y * W + X) * 4 + 3] === 0) continue;
      const xa = hmap(X, Y, ya);
      XA[Y * W + X] = xa;
      const s = sampleB(xa, ya);
      for (let c = 0; c < 3; c++)
        base[(Y * W + X) * 3 + c] = out[(Y * W + X) * 3 + c] = s[c];
    }
  }

  // ---- Lab of the mirrored front, and its blurred chroma (alpha weighted) -------------------
  const fLab = new Float32Array(W * H * 3);
  for (let p = 0; p < W * H; p++) {
    const l = rgb2lab(Fd[p * 4], Fd[p * 4 + 1], Fd[p * 4 + 2]);
    fLab[p * 3] = l[0];
    fLab[p * 3 + 1] = l[1];
    fLab[p * 3 + 2] = l[2];
  }
  async function blurChroma(sigma) {
    const buf = Buffer.alloc(W * H * 3);
    for (let p = 0; p < W * H; p++) {
      const w = Fd[p * 4 + 3] / 255;
      buf[p * 3] = Math.round(clamp(fLab[p * 3 + 1] + 128, 0, 255) * w);
      buf[p * 3 + 1] = Math.round(clamp(fLab[p * 3 + 2] + 128, 0, 255) * w);
      buf[p * 3 + 2] = Fd[p * 4 + 3];
    }
    const { data } = await sharp(buf, {
      raw: { width: W, height: H, channels: 3 },
    })
      .blur(sigma)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const res = new Float32Array(W * H * 2);
    for (let p = 0; p < W * H; p++) {
      const w = Math.max(1, data[p * 3 + 2]);
      res[p * 2] = (data[p * 3] * 255) / w - 128;
      res[p * 2 + 1] = (data[p * 3 + 1] * 255) / w - 128;
    }
    return res;
  }

  // ---- crimp foil texture (for the seam) ---------------------------------------------------
  const cRow0 = y0 + 4,
    cRow1 = Ct; // crimp band rows used as texture (outline falloff skipped)
  const cm_ = cfg.seamTexMargin ?? 60; // keep clear of the crimp's curled ends (they show as an X at the turnaround)
  const cCol0 = Math.ceil(cl) + cm_,
    cCol1 = Math.floor(cr) - cm_,
    cLen = cCol1 - cCol0;
  const sx0 = bk.seam[0] + off,
    sx1 = bk.seam[1] + off; // seam columns in output
  const seamW = sx1 - sx0;
  const sampleF = (x, y) => {
    x = clamp(x, 0, W - 1);
    y = clamp(y, 0, H - 1);
    const x0 = Math.floor(x),
      yy0 = Math.floor(y),
      x1 = Math.min(W - 1, x0 + 1),
      yy1 = Math.min(H - 1, yy0 + 1);
    const tx = x - x0,
      ty = y - yy0;
    const o = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = Fd[(yy0 * W + x0) * 4 + c],
        b = Fd[(yy0 * W + x1) * 4 + c],
        d = Fd[(yy1 * W + x0) * 4 + c],
        e = Fd[(yy1 * W + x1) * 4 + c];
      o[c] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
    }
    return o;
  };
  // along the seam: mirror-tiled crimp columns, mirrored about the pack's middle row
  const midY = (Ct + Cb) / 2;
  console.log(
    `seam texture: crimp cols ${cCol0}-${cCol1}, turnarounds at rows ${Math.round(midY - cLen / 2)} and ${Math.round(midY + cLen / 2)}`,
  );
  const alongSeam = (Y) => {
    let t = Math.abs(Y - midY) + cLen * 0.5;
    t %= 2 * cLen;
    return cCol0 + (t < cLen ? t : 2 * cLen - t);
  };

  const seamFeather = 1.5;
  const seamW8 = (X) =>
    clamp(Math.min(X - (sx0 - 0.5), sx1 - 0.5 - X) / seamFeather + 0.5, 0, 1);
  if (seamMode === 'crimp') {
    for (let Y = Ct - 2; Y <= Cb + 2; Y++) {
      const v = alongSeam(Y);
      for (let X = sx0 - 2; X <= sx1 + 1; X++) {
        const w = seamW8(X);
        if (w <= 0) continue;
        const u = (X - sx0 + 0.5) / seamW; // 0..1 across the seam -> crimp rows
        const s = sampleF(v, cRow0 + clamp(u, 0, 1) * (cRow1 - cRow0));
        const p = (Y * W + X) * 3;
        for (let c = 0; c < 3; c++) out[p + c] = lerp(out[p + c], s[c], w);
      }
    }
  } else if (seamMode === 'recolour') {
    // keep the seam's own luminance (ridges, shading); hue/chroma from the crimp's colour run
    const ramp = [];
    for (let x = cCol0; x <= cCol1; x++) {
      let a = 0,
        b = 0,
        n = 0;
      for (let y = cRow0; y <= cRow1; y++) {
        const p = (y * W + x) * 3;
        a += fLab[p + 1];
        b += fLab[p + 2];
        n++;
      }
      ramp[x] = [a / n, b / n];
    }
    const sm = (x) => {
      let a = 0,
        b = 0,
        n = 0;
      for (let k = -12; k <= 12; k++) {
        const r = ramp[clamp(Math.round(x) + k, cCol0, cCol1)];
        a += r[0];
        b += r[1];
        n++;
      }
      return [a / n, b / n];
    };
    // crimp L stats vs seam L stats for a contrast match
    const st = (vals) => {
      const m = vals.reduce((a, b) => a + b, 0) / vals.length;
      return [
        m,
        Math.sqrt(vals.reduce((a, b) => a + (b - m) ** 2, 0) / vals.length),
      ];
    };
    const cL = [],
      sL = [];
    for (let y = cRow0; y <= cRow1; y++)
      for (let x = cCol0; x <= cCol1; x += 2) cL.push(fLab[(y * W + x) * 3]);
    for (let Y = Ct; Y <= Cb; Y += 2)
      for (let X = sx0; X < sx1; X += 2) {
        const p = (Y * W + X) * 3;
        sL.push(rgb2lab(out[p], out[p + 1], out[p + 2])[0]);
      }
    const [cm, cs] = st(cL),
      [sm_, ss] = st(sL);
    for (let Y = Ct - 2; Y <= Cb + 2; Y++) {
      const [ca, cb] = sm(alongSeam(Y));
      for (let X = sx0 - 2; X <= sx1 + 1; X++) {
        const w = seamW8(X);
        if (w <= 0) continue;
        const p = (Y * W + X) * 3;
        const [L] = rgb2lab(out[p], out[p + 1], out[p + 2]);
        const L2 = clamp(cm + (L - sm_) * (cs / ss), 0, 100);
        const s = lab2rgb(L2, ca * 1.15, cb * 1.15);
        for (let c = 0; c < 3; c++) out[p + c] = lerp(out[p + c], s[c], w);
      }
    }
  }

  // ---- 4. unprinted edge strip: front foil colours, contrast lifted ------------------------
  const stripX = bk.stripRight + off; // first printed column after the strip
  // colour of the front's neon side glow at each height (same side of the pack, so the two faces
  // carry the same colour where they meet): brightness-weighted chroma of the outer band, smoothed
  const rimCol = new Float32Array(H * 2);
  const navy = [0, 0];
  {
    const raw = new Array(H).fill(null);
    for (let Y = y0; Y <= y1; Y++) {
      if (ext.L[Y] == null) continue;
      // hue = brightness-weighted mean direction, chroma = brightness-weighted mean magnitude,
      // so neighbouring pink and cyan lines give a saturated violet rather than a grey average
      let a = 0,
        b = 0,
        cm = 0,
        n = 0;
      for (
        let X = Math.ceil(ext.L[Y]) + cfg.strip.rimBand[0];
        X <= Math.ceil(ext.L[Y]) + cfg.strip.rimBand[1];
        X++
      ) {
        const p = (Y * W + X) * 3;
        const L = fLab[p];
        const C = Math.hypot(fLab[p + 1], fLab[p + 2]);
        const wgt = L > 25 ? C * C : 0; // the saturated glow halos, not the white-hot cores
        a += fLab[p + 1] * wgt;
        b += fLab[p + 2] * wgt;
        cm += C * wgt;
        n += wgt;
      }
      if (n > 0) {
        const h = Math.hypot(a, b) || 1;
        raw[Y] = [(a / h) * (cm / n), (b / h) * (cm / n)];
      }
    }
    const sig = cfg.strip.rimBlur;
    for (let Y = 0; Y < H; Y++) {
      let a = 0,
        b = 0,
        n = 0;
      for (let k = -3 * sig; k <= 3 * sig; k++) {
        const r = raw[Y + k];
        if (!r) continue;
        const g = Math.exp(-(k * k) / (2 * sig * sig));
        a += r[0] * g;
        b += r[1] * g;
        n += g;
      }
      if (n > 0) {
        rimCol[Y * 2] = a / n;
        rimCol[Y * 2 + 1] = b / n;
      }
    }
    // the front's dark foil colour: mean chroma of its body pixels with L in [10, 30]
    {
      let a = 0,
        b = 0,
        n = 0;
      for (let Y = Ct; Y <= Cb; Y += 2)
        for (let X = 0; X < W; X += 2) {
          const p = Y * W + X;
          if (Fd[p * 4 + 3] < 200) continue;
          const L = fLab[p * 3];
          if (L < 10 || L > 30) continue;
          a += fLab[p * 3 + 1];
          b += fLab[p * 3 + 2];
          n++;
        }
      navy[0] = a / n;
      navy[1] = b / n;
      console.log(
        `front navy chroma a=${navy[0].toFixed(1)} b=${navy[1].toFixed(1)}`,
      );
    }
    if (process.env.DEBUG)
      for (let Y = 150; Y < H; Y += 150)
        console.log(
          'rimCol',
          Y,
          rimCol[Y * 2].toFixed(1),
          rimCol[Y * 2 + 1].toFixed(1),
          raw[Y] && raw[Y].map((v) => v.toFixed(1)).join(','),
        );
  }
  {
    const vals = [];
    for (let Y = Ct; Y <= Cb; Y += 2)
      for (let X = Math.ceil(mL[Y] ?? 0) + 2; X < stripX - 1; X++) {
        const p = (Y * W + X) * 3;
        vals.push(rgb2lab(out[p], out[p + 1], out[p + 2])[0]);
      }
    const m = vals.reduce((a, b) => a + b, 0) / vals.length;
    // target L statistics: the front's crimp band (its brightest foil)
    const tv = [];
    for (let y = cRow0; y <= cRow1; y++)
      for (let x = cCol0; x <= cCol1; x += 2) tv.push(fLab[(y * W + x) * 3]);
    const tm =
      tv.reduce((a, b) => a + b, 0) / tv.length + (cfg.strip.lift || 0);
    // split the strip's L into gloss detail (kept, boosted) and its slow top-to-bottom drift (tamed)
    const Lbuf = Buffer.alloc(W * H);
    for (let p = 0; p < W * H; p++)
      Lbuf[p] = Math.round(
        clamp(
          rgb2lab(out[p * 3], out[p * 3 + 1], out[p * 3 + 2])[0] * 2.55,
          0,
          255,
        ),
      );
    const lr = await sharp(Lbuf, { raw: { width: W, height: H, channels: 1 } })
      .blur(cfg.strip.driftBlur || 24)
      .extractChannel(0)
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (lr.info.channels !== 1)
      throw new Error(`blurred L has ${lr.info.channels} channels`);
    const Lsm = lr.data;
    console.log(
      `strip: L mean ${m.toFixed(1)} -> ${tm.toFixed(1)}, gloss x${cfg.strip.contrast}, drift x${cfg.strip.drift}`,
    );
    // emboss grain: high-pass of the clean front art (no badge/pill overlays), clamped so neon
    // line edges don't transfer, added inside the strip only
    const grain = new Float32Array(W * H);
    if (cfg.strip.grain && cfg.strip.grain.amount > 0) {
      const G = await rawRGBA(cfg.strip.grain.source, { flop: true });
      const gl = Buffer.alloc(W * H);
      for (let p = 0; p < W * H; p++)
        gl[p] = Math.round(
          clamp(
            rgb2lab(G.data[p * 4], G.data[p * 4 + 1], G.data[p * 4 + 2])[0] *
              2.55,
            0,
            255,
          ),
        );
      const gb = await sharp(gl, { raw: { width: W, height: H, channels: 1 } })
        .blur(cfg.strip.grain.sigma)
        .extractChannel(0)
        .raw()
        .toBuffer();
      const cmax = cfg.strip.grain.clamp;
      for (let p = 0; p < W * H; p++)
        grain[p] =
          clamp((gl[p] - gb[p]) / 2.55, -cmax, cmax) * cfg.strip.grain.amount;
    }
    for (let Y = Ct - 2; Y <= Cb + 2; Y++) {
      if (mL[Y] == null) continue;
      for (let X = 0; X < stripX + 1; X++) {
        const w = X <= stripX - 1 ? 1 : X === stripX ? 0.5 : 0;
        if (w <= 0) continue;
        if (Fd[(Y * W + X) * 4 + 3] === 0) continue;
        const p = (Y * W + X) * 3;
        const [L, a, b] = rgb2lab(out[p], out[p + 1], out[p + 2]);
        const Ls = Lsm[Y * W + X] / 2.55;
        const L2 = clamp(
          tm +
            (L - Ls) * cfg.strip.contrast +
            (Ls - m) * cfg.strip.drift +
            grain[Y * W + X],
          0,
          100,
        );
        // darks take the front's navy, brights its neon (as on the front's foil)
        const t0 = clamp(
            (L2 - cfg.strip.navyToNeon[0]) /
              (cfg.strip.navyToNeon[1] - cfg.strip.navyToNeon[0]),
            0,
            1,
          ),
          t = t0 * t0 * (3 - 2 * t0);
        const ca = lerp(navy[0], rimCol[Y * 2] * cfg.strip.chromaGain, t),
          cb = lerp(navy[1], rimCol[Y * 2 + 1] * cfg.strip.chromaGain, t);
        const s = lab2rgb(L2, ca, cb);
        for (let c = 0; c < 3; c++) out[p + c] = lerp(out[p + c], s[c], w);
      }
    }
  }

  // ---- 5. shared rim: the mirrored front's outer edge, fading inward ----------------------
  for (let Y = Ct; Y <= Cb; Y++) {
    if (mL[Y] == null) continue;
    for (let X = 0; X < W; X++) {
      const d = Math.min(X - ext.L[Y], ext.R[Y] - X);
      const w =
        d <= cfg.rim.solid
          ? 1
          : d >= cfg.rim.solid + cfg.rim.fade
            ? 0
            : 1 - (d - cfg.rim.solid) / cfg.rim.fade;
      if (w <= 0) continue;
      const p = (Y * W + X) * 3;
      for (let c = 0; c < 3; c++)
        out[p + c] = lerp(
          out[p + c],
          Fd[(Y * W + X) * 4 + c],
          w * w * (3 - 2 * w),
        );
    }
  }

  // ---- 6. front crimps, full strength, short feather + contact shadow on the body side -----
  const fe = cfg.feather;
  const crimpW = (Y) => {
    const dTop = Y - Ct,
      dBot = Cb - Y;
    const d = Math.min(dTop, dBot);
    if (d <= fe.start) return 1;
    if (d >= fe.end) return 0;
    const t = 1 - (d - fe.start) / (fe.end - fe.start);
    return t * t * (3 - 2 * t);
  };
  for (let Y = y0; Y <= y1; Y++) {
    const d = Math.min(Y - Ct, Cb - Y);
    const w = crimpW(Y);
    const sh =
      d > 0 && d < fe.shadowLen
        ? 1 - fe.shadow * Math.pow(1 - d / fe.shadowLen, 2)
        : 1;
    for (let X = 0; X < W; X++) {
      const p = (Y * W + X) * 3;
      for (let c = 0; c < 3; c++)
        out[p + c] = lerp(out[p + c] * sh, Fd[(Y * W + X) * 4 + c], w);
    }
  }

  // ---- write: RGB + the mirrored front's alpha, byte for byte --------------------------------
  const png = Buffer.alloc(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    for (let c = 0; c < 3; c++)
      png[p * 4 + c] = Math.round(clamp(out[p * 3 + c], 0, 255));
    png[p * 4 + 3] = Fd[p * 4 + 3];
  }
  const work = path.join(cfg.workDir, `${cfg.name}-back-${seamMode}.png`);
  await sharp(png, { raw: { width: W, height: H, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(work);
  const bpng = Buffer.alloc(W * H * 4);
  for (let p = 0; p < W * H; p++) {
    for (let c = 0; c < 3; c++)
      bpng[p * 4 + c] = Math.round(clamp(base[p * 3 + c], 0, 255));
    bpng[p * 4 + 3] = Fd[p * 4 + 3];
  }
  await sharp(bpng, { raw: { width: W, height: H, channels: 4 } })
    .png()
    .toFile(path.join(cfg.workDir, `${cfg.name}-base.png`));
  console.log('wrote', work);

  // ---- checks ---------------------------------------------------------------------------------
  // a) alpha equals the mirrored front's alpha
  const chk = await rawRGBA(work);
  let aDiff = 0;
  for (let p = 0; p < W * H; p++)
    if (chk.data[p * 4 + 3] !== Fd[p * 4 + 3]) aDiff++;
  // b) every FIXED print pixel is byte-identical to backRef (shifted by off, dy). The live-text
  //    zones (geometry printZones, blanked by make-plate.cjs) are left out: their painted text
  //    is replaced on the plate, so only the fixed wording is held to pixel identity.
  const prevGeo = loadGeometry(cfg);
  const liveRects = zoneRects(prevGeo, W, H, 'live');
  let prot = 0,
    protDiff = 0;
  const rimGuard = cfg.rim.solid + cfg.rim.fade + 1;
  for (let Y = T0 + dy; Y <= T1 + dy; Y++) {
    for (let X = stripX + 2; X <= xR + off - 1; X++) {
      if (X >= sx0 - 3 && X <= sx1 + 2) continue; // seam
      if (X > ext.R[Y] - rimGuard) continue;
      if (inRects(liveRects, X, Y)) continue; // live-text zone
      prot++;
      const p = (Y * W + X) * 4,
        q = ((Y - dy) * W + (X - off)) * 3;
      if (
        chk.data[p] !== Bd[q] ||
        chk.data[p + 1] !== Bd[q + 1] ||
        chk.data[p + 2] !== Bd[q + 2]
      )
        protDiff++;
    }
  }
  // c) no background black inside the mask: test the pure warp (the seam/rim come from the front
  //    and are legitimately dark in places)
  let black = 0;
  for (let Y = Ct; Y <= Cb; Y++)
    for (let X = 0; X < W; X++) {
      const p = Y * W + X;
      if (
        Fd[p * 4 + 3] >= 128 &&
        Math.max(base[p * 3], base[p * 3 + 1], base[p * 3 + 2]) < 6
      )
        black++;
    }
  if (black > 0)
    throw new Error(
      `coverage: ${black} background-black pixels inside the outline in the warped body`,
    );
  if (aDiff > 0)
    throw new Error(`alpha differs from the mirrored front in ${aDiff} px`);
  if (protDiff > 0) throw new Error(`fixed print changed in ${protDiff} px`);
  // d) margins of the print to the outline
  console.log(
    `check: alpha mismatch ${aDiff} px; fixed print pixels ${prot} (${liveRects.length} live-text zones left out), changed ${protDiff}; background-black inside outline ${black}`,
  );
  console.log(
    `print box: rows ${T0 + dy}-${T1 + dy}, cols ${stripX}-${xR + off}; seam cols ${sx0}-${sx1 - 1}; outline at mid row ${mL[(Ct + Cb) >> 1].toFixed(1)}-${mR[(Ct + Cb) >> 1].toFixed(1)}`,
  );

  const geo = {
    pack: cfg.name,
    image: { width: W, height: H, file: `${cfg.name}-back-matched.png` },
    note: 'Fractions of image width (x) and height (y). The back is the front mirrored left-right: x here = 1 - x on the front.',
    alphaThreshold: 128,
    alphaInterior: 'about 250 (0.98), copied from the front',
    bounds: (() => {
      let a = W,
        b = -1;
      for (let p = 0; p < W * H; p++)
        if (Fd[p * 4 + 3] >= 128) {
          const x = p % W;
          if (x < a) a = x;
          if (x > b) b = x;
        }
      return {
        x0: +(a / W).toFixed(4),
        x1: +((b + 1) / W).toFixed(4),
        y0: +(y0 / H).toFixed(4),
        y1: +((y1 + 1) / H).toFixed(4),
      };
    })(),
    body: {
      x0: +(mL[(Ct + Cb) >> 1] / W).toFixed(4),
      x1: +((mR[(Ct + Cb) >> 1] + 1) / W).toFixed(4),
      note: 'straight side edges between the shoulders',
    },
    crimpTop: { y0: +(y0 / H).toFixed(4), y1: +(Ct / H).toFixed(4) },
    crimpBottom: { y0: +(Cb / H).toFixed(4), y1: +((y1 + 1) / H).toFixed(4) },
    finSeal: {
      x0: +(sx0 / W).toFixed(4),
      x1: +(sx1 / W).toFixed(4),
      mode: seamMode,
    },
    printArea: {
      x0: +(stripX / W).toFixed(4),
      x1: +((xR + off) / W).toFixed(4),
      y0: +((T0 + dy) / H).toFixed(4),
      y1: +((T1 + dy) / H).toFixed(4),
    },
    // The hand-set live-text zones are carried over, never regenerated.
    ...(prevGeo?.printZones ? { printZones: prevGeo.printZones } : {}),
  };
  fs.writeFileSync(
    path.join(cfg.workDir, `${cfg.name}-back-geometry.json`),
    JSON.stringify(geo, null, 2),
  );
  if (FINAL) {
    fs.copyFileSync(
      work,
      path.join(cfg.outDir, `${cfg.name}-back-matched.png`),
    );
    fs.writeFileSync(
      path.join(cfg.outDir, `${cfg.name}-back-geometry.json`),
      JSON.stringify(geo, null, 2) + '\n',
    );
    console.log('final written to', cfg.outDir);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
