/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS script: require() is its only import form */
// Measures one tier's approved picture and fits the capsule shape and camera to
// it (ported from the Gold-only research scripts measure-art.cjs and
// fit-camera.cjs, made tier-agnostic):
// - silhouette from alpha >= 128; capsule axis = principal axis of the mask;
// - the shape: a segment swept by a sphere (radius R, sphere centres at +-hc),
//   whose perspective silhouette is rasterised analytically with soft edges and
//   fitted (R, hc, roll, tx, ty) by soft-IoU;
// - the camera: NOT fitted per tier. Every tier uses the Gold prototype's
//   verified pick, F = 24, elev = 8.5 (the five pictures share one render
//   set-up; the seam arch, the only cue for elevation, is too noisy on the
//   non-gold caps: on Gold this detector's arch even preferred elev 0);
// - the seam (cap / glass join) height: along lines parallel to the axis,
//   where the smoothed colour crosses halfway from the cap's own colour to the
//   glass half's mean colour (Gold's script used "goldness", meaningless on
//   Silver, Platinum or Diamond); for glitter, where the busy texture gives way
//   to the smooth glass collar. The ring's height is the least-median fit.
const { deg, clamp } = require('./lib.cjs');

const D = 10;

function measureArt(img) {
  const { d: data, W, H } = img;
  const A = (x, y) => data[(y * W + x) * 4 + 3];
  let n = 0,
    sx = 0,
    sy = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (A(x, y) >= 128) {
        n++;
        sx += x + 0.5;
        sy += y + 0.5;
      }
  const cx = sx / n,
    cy = sy / n;
  let cxx = 0,
    cyy = 0,
    cxy = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (A(x, y) >= 128) {
        const dx = x + 0.5 - cx,
          dy = y + 0.5 - cy;
        cxx += dx * dx;
        cyy += dy * dy;
        cxy += dx * dy;
      }
  const theta = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
  let ax = Math.cos(theta),
    ay = Math.sin(theta);
  if (ay > 0) {
    ax = -ax;
    ay = -ay;
  }
  const alpha = (x, y) => {
    const x0 = Math.floor(x - 0.5),
      y0 = Math.floor(y - 0.5),
      fx = x - 0.5 - x0,
      fy = y - 0.5 - y0;
    const g = (xx, yy) =>
      xx < 0 || yy < 0 || xx >= W || yy >= H ? 0 : A(xx, yy);
    return (
      (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) +
      (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy
    );
  };
  const tip = (dir) => {
    let prev = 255;
    for (let t = 0; t < 1400; t += 0.25) {
      const a = alpha(cx + ax * t * dir, cy + ay * t * dir);
      if (a < 128)
        return t - 0.25 + (0.25 * (prev - 128)) / Math.max(1e-6, prev - a);
      prev = a;
    }
    return null;
  };
  const px = -ay,
    py = ax;
  let maxW = 0;
  for (let s = -600; s <= 600; s += 10) {
    let l = 0,
      r = 0;
    for (let t = 0; t < 700; t += 0.5)
      if (alpha(cx + ax * s - px * t, cy + ay * s - py * t) >= 128) l = t;
    for (let t = 0; t < 700; t += 0.5)
      if (alpha(cx + ax * s + px * t, cy + ay * s + py * t) >= 128) r = t;
    maxW = Math.max(maxW, l + r);
  }
  const top = tip(1),
    bottom = tip(-1);
  return {
    image: { W, H },
    centroid: [cx, cy],
    axisUp: [ax, ay],
    tiltDegFromVertical: (Math.atan2(-ax, -ay) * 180) / Math.PI,
    tipTop: top,
    tipBottom: bottom,
    lengthPx: top + bottom,
    maxWidthPx: maxW,
  };
}

function axisOf(p) {
  const ce = Math.cos(p.elev * deg),
    se = Math.sin(p.elev * deg);
  const y = [0, ce, -se];
  const cr = Math.cos(p.roll * deg),
    sr = Math.sin(p.roll * deg);
  return [y[0] * cr - y[1] * sr, y[0] * sr + y[1] * cr, y[2]];
}

/** Soft coverage of pixel centre (u, v) by the swept sphere. */
function makeCoverage(W, H) {
  return (p) => {
    const t = Math.tan((p.F * deg) / 2);
    const a = axisOf(p);
    const C = [p.tx, p.ty, -D];
    const P0 = [C[0] - a[0] * p.hc, C[1] - a[1] * p.hc, C[2] - a[2] * p.hc];
    const pw = (2 * t) / H;
    return (u, v) => {
      const dx = ((2 * u) / W - 1) * t * (W / H),
        dy = (1 - (2 * v) / H) * t;
      const dl = Math.hypot(dx, dy, 1);
      const d0 = dx / dl,
        d1 = dy / dl,
        d2 = -1 / dl;
      const w0 = -P0[0],
        w1 = -P0[1],
        w2 = -P0[2];
      const b = d0 * a[0] + d1 * a[1] + d2 * a[2];
      const dd = d0 * w0 + d1 * w1 + d2 * w2;
      const ee = a[0] * w0 + a[1] * w1 + a[2] * w2;
      let q = (ee - b * dd) / (1 - b * b);
      q = clamp(q, 0, 2 * p.hc);
      let X0 = P0[0] + a[0] * q,
        X1 = P0[1] + a[1] * q,
        X2 = P0[2] + a[2] * q;
      let s = Math.max(0, X0 * d0 + X1 * d1 + X2 * d2);
      const e1 = Math.hypot(X0 - d0 * s, X1 - d1 * s, X2 - d2 * s);
      let q2 =
        (d0 * s - P0[0]) * a[0] +
        (d1 * s - P0[1]) * a[1] +
        (d2 * s - P0[2]) * a[2];
      q2 = clamp(q2, 0, 2 * p.hc);
      X0 = P0[0] + a[0] * q2;
      X1 = P0[1] + a[1] * q2;
      X2 = P0[2] + a[2] * q2;
      const s2 = Math.max(0, X0 * d0 + X1 * d1 + X2 * d2);
      const dist = Math.min(
        e1,
        Math.hypot(X0 - d0 * s2, X1 - d1 * s2, X2 - d2 * s2),
      );
      return clamp(0.5 + (p.R - dist) / (pw * s2), 0, 1);
    };
  };
}

function projectW(p, W, H, X) {
  const t = Math.tan((p.F * deg) / 2),
    z = -X[2];
  return [
    ((X[0] / z / (t * (W / H)) + 1) * W) / 2,
    ((1 - X[1] / z / t) * H) / 2,
  ];
}

/** The seam, measured: per offset across the axis, the s where the colour crosses halfway from cap to glass. */
function measureSeam(img, M, mode = 'colour') {
  const { d: data, W, H } = img;
  const [ax, ay] = M.axisUp,
    px = -ay,
    py = ax,
    [cx, cy] = M.centroid;
  const at = (s, off) => {
    const x = Math.round(cx + ax * s + px * off),
      y = Math.round(cy + ay * s + py * off);
    if (x < 0 || y < 0 || x >= W || y >= H) return null;
    const q = (y * W + x) * 4;
    if (data[q + 3] < 200) return null;
    return [data[q], data[q + 1], data[q + 2]];
  };
  const mean = (s0, s1, off, ds = 1) => {
    const m = [0, 0, 0];
    let n = 0;
    for (let s = s0; s <= s1; s += ds)
      for (let o = -4; o <= 4; o++) {
        const c = at(s, off + o);
        if (!c) continue;
        m[0] += c[0];
        m[1] += c[1];
        m[2] += c[2];
        n++;
      }
    return n ? m.map((v) => v / n) : null;
  };
  const seam = [];
  if (mode === 'texture') {
    // glitter: the cap is busy, the glass collar just under the seam is
    // smooth. Feature: local mean |Laplacian| of luminance; the seam is the
    // first s (walking down) where it falls under 45% of the cap's own.
    const lum = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++)
      lum[i] =
        0.2126 * data[i * 4] +
        0.7152 * data[i * 4 + 1] +
        0.0722 * data[i * 4 + 2];
    const lap = new Float32Array(W * H);
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        lap[i] = Math.abs(
          4 * lum[i] - lum[i - 1] - lum[i + 1] - lum[i - W] - lum[i + W],
        );
      }
    const energy = (s0, s1, off) => {
      let e = 0,
        n = 0;
      for (let s = s0; s <= s1; s += 1)
        for (let o = -5; o <= 5; o++) {
          const x = Math.round(cx + ax * s + px * (off + o)),
            y = Math.round(cy + ay * s + py * (off + o));
          if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) continue;
          if (data[(y * W + x) * 4 + 3] < 200) continue;
          e += lap[y * W + x];
          n++;
        }
      return n ? e / n : null;
    };
    for (let off = -300; off <= 300; off += 8) {
      const cap = energy(110, 170, off);
      if (!cap) continue;
      let hit = null;
      for (let s = 150; s > -40; s -= 0.5) {
        const e = energy(s - 3, s + 3, off);
        if (e != null && e < 0.45 * cap) {
          hit = s;
          break;
        }
      }
      if (hit != null) seam.push({ off, s: hit });
    }
  }
  for (let off = -300; mode !== 'texture' && off <= 300; off += 8) {
    const cap = mean(110, 170, off);
    const glass = mean(-260, -90, off, 2);
    if (!cap || !glass) continue;
    const g = [glass[0] - cap[0], glass[1] - cap[1], glass[2] - cap[2]];
    const gg = g[0] * g[0] + g[1] * g[1] + g[2] * g[2];
    if (gg < 400) continue; // cap and glass too alike here to tell apart
    let hit = null;
    for (let s = 150; s > -40; s -= 0.5) {
      const c = mean(s - 2, s + 2, off);
      if (!c) continue;
      const t =
        ((c[0] - cap[0]) * g[0] +
          (c[1] - cap[1]) * g[1] +
          (c[2] - cap[2]) * g[2]) /
        gg;
      if (t > 0.5) {
        hit = s;
        break;
      }
    }
    if (hit != null) seam.push({ off, s: hit });
  }
  // drop outliers: more than 25 px from the running median of neighbours
  const keep = seam.filter((q, i) => {
    const nb = seam
      .slice(Math.max(0, i - 3), i + 4)
      .map((r) => r.s)
      .sort((a, b) => a - b);
    return Math.abs(q.s - nb[nb.length >> 1]) < 25;
  });
  return keep;
}

async function fitTier(img, M, log = () => {}, seamMode = 'colour') {
  const { d: data, W, H } = img;
  const art = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) art[i] = data[i * 4 + 3] / 255;
  const inside = (x, y) =>
    x >= 0 && y >= 0 && x < W && y < H && art[y * W + x] >= 0.5;
  const BAND = 30;
  const edgeMap = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = inside(x, y);
      if (inside(x + 1, y) !== i || inside(x, y + 1) !== i)
        edgeMap[y * W + x] = 1;
    }
  const near = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (edgeMap[y * W + x])
        for (
          let yy = Math.max(0, y - BAND);
          yy <= Math.min(H - 1, y + BAND);
          yy++
        )
          for (
            let xx = Math.max(0, x - BAND);
            xx <= Math.min(W - 1, x + BAND);
            xx++
          )
            near[yy * W + xx] = 1;
  const bandFull = [],
    bandCoarse = [];
  let fixedIn = 0,
    fixedInCoarse = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const coarse = x % 2 === 0 && y % 2 === 0;
      if (near[y * W + x]) {
        bandFull.push(x, y);
        if (coarse) bandCoarse.push(x, y);
      } else if (art[y * W + x] >= 0.5) {
        fixedIn++;
        if (coarse) fixedInCoarse++;
      }
    }
  const cov = makeCoverage(W, H);
  const iouWith = (band, fixed) => (p) => {
    const f = cov(p);
    let I = fixed,
      U = fixed;
    for (let k = 0; k < band.length; k += 2) {
      const x = band[k],
        y = band[k + 1];
      const m = f(x + 0.5, y + 0.5),
        g = art[y * W + x];
      I += Math.min(m, g);
      U += Math.max(m, g);
    }
    return I / U;
  };
  const iouCoarse = iouWith(bandCoarse, fixedInCoarse),
    iouFull = iouWith(bandFull, fixedIn);
  const init = (F, elev) => {
    const ppu = H / (2 * D * Math.tan((F * deg) / 2));
    const Rpx = M.maxWidthPx / 2;
    return {
      F,
      elev,
      R: Rpx / ppu,
      hc: M.lengthPx / 2 / ppu - Rpx / ppu,
      roll: M.tiltDegFromVertical,
      tx: (M.centroid[0] - W / 2) / ppu,
      ty: -(M.centroid[1] - H / 2) / ppu,
    };
  };
  const fitShape = (p0, iou, minStep = 1e-5) => {
    const p = { ...p0 };
    const steps = { R: 0.004, hc: 0.006, roll: 0.1, tx: 0.004, ty: 0.004 };
    let best = iou(p);
    for (let round = 0; round < 60; round++) {
      let moved = false;
      for (const k of Object.keys(steps))
        for (const dir of [1, -1]) {
          const q = { ...p, [k]: p[k] + dir * steps[k] };
          const v = iou(q);
          if (v > best) {
            best = v;
            Object.assign(p, q);
            moved = true;
            break;
          }
        }
      if (!moved) {
        for (const k of Object.keys(steps)) steps[k] *= 0.5;
        if (steps.R < minStep) break;
      }
    }
    return { p, iou: best };
  };

  const seam = measureSeam(img, M, seamMode);
  const [ax, ay] = M.axisUp,
    px = -ay,
    py = ax,
    [cx, cy] = M.centroid;
  const seamModel = (p, ts) => {
    const a = axisOf(p);
    const cr = Math.cos(p.roll * deg),
      sr = Math.sin(p.roll * deg);
    const u = [cr, sr, 0];
    const w = [
      a[1] * u[2] - a[2] * u[1],
      a[2] * u[0] - a[0] * u[2],
      a[0] * u[1] - a[1] * u[0],
    ];
    const C = [p.tx + a[0] * ts, p.ty + a[1] * ts, -D + a[2] * ts];
    const pts = [];
    for (let k = 0; k <= 720; k++) {
      const ph = (k / 720) * Math.PI * 2;
      const N = [
        u[0] * Math.cos(ph) + w[0] * Math.sin(ph),
        u[1] * Math.cos(ph) + w[1] * Math.sin(ph),
        u[2] * Math.cos(ph) + w[2] * Math.sin(ph),
      ];
      const X = [C[0] + N[0] * p.R, C[1] + N[1] * p.R, C[2] + N[2] * p.R];
      if (N[0] * -X[0] + N[1] * -X[1] + N[2] * -X[2] <= 0) continue;
      const [x, y] = projectW(p, W, H, X);
      const dx = x - cx,
        dy = y - cy;
      pts.push([dx * px + dy * py, dx * ax + dy * ay]);
    }
    return pts;
  };
  const seamErr = (p) => {
    let best = null;
    for (let ts = -0.3; ts <= 0.6; ts += 0.002) {
      const pts = seamModel(p, ts);
      let e = 0,
        n = 0;
      for (const m of seam) {
        if (Math.abs(m.off) > 300) continue;
        let bp = null;
        for (const q of pts)
          if (!bp || Math.abs(q[0] - m.off) < Math.abs(bp[0] - m.off)) bp = q;
        if (!bp || Math.abs(bp[0] - m.off) > 4) continue;
        e += (bp[1] - m.s) ** 2;
        n++;
      }
      if (!n) continue;
      const rms = Math.sqrt(e / n);
      if (!best || rms < best.rms) best = { ts, rms, n };
    }
    return best || { ts: 0, rms: Infinity, n: 0 };
  };
  // the seam ring's axial position alone: least median residual (robust to
  // the detector's stray hits on tickets and on the lip's highlight)
  const seamTs = (p) => {
    let best = null;
    for (let ts = -0.3; ts <= 0.6; ts += 0.002) {
      const pts = seamModel(p, ts);
      const res = [];
      for (const m of seam) {
        let bp = null;
        for (const q of pts)
          if (!bp || Math.abs(q[0] - m.off) < Math.abs(bp[0] - m.off)) bp = q;
        if (!bp || Math.abs(bp[0] - m.off) > 4) continue;
        res.push(Math.abs(bp[1] - m.s));
      }
      if (res.length < 8) continue;
      res.sort((a, b) => a - b);
      const med = res[res.length >> 1];
      if (!best || med < best.median) best = { ts, median: med, n: res.length };
    }
    return best || { ts: 0, median: Infinity, n: 0 };
  };

  // The camera: the Gold prototype's pick (F 24, elev 8.5), shared by every
  // tier. All five pictures come from one render set-up (same pose and
  // framing), and the seam arch, the only thing that pins the elevation, is
  // too noisy on the non-gold caps to fit it per tier (on Gold itself this
  // detector's arch preferred elev 0, against the prototype's verified 8.5).
  // The silhouette (R, hc, roll, tx, ty) and the seam height are fitted per tier.
  void iouCoarse;
  const r0 = fitShape(init(24, 8.5), iouFull);
  const rmsAll = seamErr(r0.p);
  const ts = seamTs(r0.p);
  log(
    `  iou ${r0.iou.toFixed(5)} seam ts ${ts.ts.toFixed(3)} median ${ts.median.toFixed(1)} px (${ts.n} points)`,
  );
  const fine = {
    F: 24,
    elev: 8.5,
    iou: r0.iou,
    seamRms: rmsAll.rms,
    seamMedianPx: ts.median,
    ts: ts.ts,
    p: r0.p,
  };
  const p = fine.p,
    sc = 1 / p.R;
  return {
    measure: M,
    seamMeasured: seam,
    pick: { ...fine, camera: 'gold prototype pick (shared)' },
    fit: {
      F: p.F,
      elev: p.elev,
      roll: p.roll,
      D: D * sc,
      tx: p.tx * sc,
      ty: p.ty * sc,
      HC: p.hc * sc,
      SEAM: fine.ts * sc,
    },
  };
}

module.exports = { measureArt, fitTier, measureSeam };
