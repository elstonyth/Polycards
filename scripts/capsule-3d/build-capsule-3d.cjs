/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS script: require() is its only import form */
// Builds the 3D capsule assets for all five capsule tiers from their own
// approved pictures (public/images/polycards/capsule<tier>-pack.webp) and the
// fits run-fit.cjs wrote. No image generation of any kind: every texture is
// sampled from the tier's picture, except the shared logo mask, which is
// rasterised from the site's own vector logo paths.
//
//   node scripts/capsule-3d/run-fit.cjs            # once, or when a picture changes
//   node scripts/capsule-3d/build-capsule-3d.cjs   # assets + manifest
//
// Method ("version C" of docs/research/home-3d/capsule-3d, ported):
// - Cap: a material capture (matcap) sampled from the picture's cap pixels,
//   looked up with the view-corrected normal (three.js MeshMatcapMaterial's
//   frame), so its lighting stays with the outline as the capsule leans.
// - Logo: NOT geometry. A signed-distance mask of the vector logo, placed on
//   the cap by (phi, m) and drawn in the cap's own shader; its enamel colour is
//   a small matcap sampled from the picture's logo pixels (dark or white), its
//   raised edge a normal bend from the distance field. The placement is fitted
//   per tier to the picture's logo (soft IoU).
// - Glitter (Diamond): the matcap carries the lighting (per-normal average of
//   the glitter); the stones themselves ride with the surface as an albedo
//   ratio (picture / matcap), sampled where the surface sat in the picture;
//   under the logo the stones are filled from glitter nearby, not blurred.
// - Glass: the picture's ticket contents (cropped to the glass half) carried by
//   an inner surface, under a live glass layer whose rim comes from the
//   picture's own rim band (a second matcap, RGBA).
//
// Writes
//   public/pack-3d/<id>/{cap-matcap,glass-matcap,logo-matcap,contents[,detail]}[-half].webp
//   public/pack-3d/capsule-logo/logo-sdf[-half].webp          (shared by all five)
//   src/components/pack-3d/capsule/capsule-manifest.ts         (generated)
//   docs/research/home-3d/capsule-3d/out/fit/<name>-*.png|json (checks)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const L = require('./lib.cjs');
const { overlay } = require('./overlay.cjs');

const { repo, sharp, TIERS, clamp, toLin, LIN, toSrgb, dot, cross, norm } = L;
const PUBLIC = path.join(repo, 'public/pack-3d');
const MODULE = path.join(repo, 'src/components/pack-3d/capsule');
const RESEARCH = path.join(repo, 'docs/research/home-3d/capsule-3d/out/fit');
const sha8 = (buf) =>
  crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);

// the logo's distance field: viewBox units per side of the encoded range, and
// atlas resolution (px per viewBox unit) for the full and half files
const SDF_RANGE = 6;
const SDF_PPU = { full: 3, half: 1.5 };
const HI_PPU = 12;
const MATCAP = { full: 256, half: 128 };
const LOGO_MATCAP = 128;
// albedo ratio range stored in the glitter detail texture (sRGB of ratio / 4)
const DETAIL_SCALE = 4;
const DETAIL_FULL_SCALE = 0.8;

// ------------------------------------------------------------------ per-pixel geometry
function pixelGeometry(img, P) {
  const { W, H } = img;
  const n = W * H;
  const g = {
    hit: new Uint8Array(n),
    y: new Float32Array(n),
    phi: new Float32Array(n),
    m: new Float32Array(n),
    u: new Float32Array(n),
    v: new Float32Array(n),
    nc: new Float32Array(n * 3), // the normal in the pixel's own view frame
  };
  for (let yy = 0; yy < H; yy++)
    for (let xx = 0; xx < W; xx++) {
      const i = yy * W + xx;
      const h = L.hitPill(P, L.rayAt(P, W, H, xx + 0.5, yy + 0.5));
      if (!h) continue;
      g.hit[i] = 1;
      const l = L.toLocal(P, h.p);
      const [phi, m] = L.phiM(P, l);
      g.y[i] = l[1];
      g.phi[i] = phi;
      g.m[i] = m;
      const view = norm([-h.p[0], -h.p[1], -h.p[2]]);
      const [u, v] = L.matcapUV(h.n, view);
      g.u[i] = u;
      g.v[i] = v;
      g.nc[i * 3] = u;
      g.nc[i * 3 + 1] = v;
      g.nc[i * 3 + 2] = Math.sqrt(Math.max(0, 1 - u * u - v * v));
    }
  return g;
}

// ------------------------------------------------------------------ logo
function sampleRaster(r, X, Y, outside = 0) {
  const fx = (X - r.box.x0) * r.ppu - 0.5,
    fy = (Y - r.box.y0) * r.ppu - 0.5;
  if (fx < 0 || fy < 0 || fx >= r.w - 1 || fy >= r.h - 1) return outside;
  const x0 = Math.floor(fx),
    y0 = Math.floor(fy),
    ax = fx - x0,
    ay = fy - y0;
  const a = r.a,
    w = r.w,
    i = y0 * w + x0;
  return (
    (a[i] * (1 - ax) + a[i + 1] * ax) * (1 - ay) +
    (a[i + w] * (1 - ax) + a[i + w + 1] * ax) * ay
  );
}
/**
 * Logo coverage at (phi, m) for a placement { mark: {k, phi0, m0, inflate},
 * word: {...} }. `inflate` (viewBox units) grows the outline along its
 * distance field: the pictures' raised logos are bolder than the site's paths.
 * hi[b] = { r: raster (for its box and ppu), s: signed distance per texel }.
 */
function makeLogoAt(blocks, hi) {
  return (place) => (phi, m) => {
    let c = 0;
    for (const b of ['mark', 'word']) {
      const p = place[b],
        B = blocks[b];
      const X = B.cx + (phi - p.phi0) / p.k,
        Y = B.cy - (m - p.m0) / p.k;
      const sd = sampleRaster({ ...hi[b].r, a: hi[b].s }, X, Y, -9);
      c = Math.max(c, clamp(0.5 + (sd + (p.inflate || 0)) / 0.6, 0, 1));
    }
    return c;
  };
}

/** How much a picture pixel looks like the tier's logo ink (0..1). */
function logoLikeness(img, i, colour) {
  const r = img.d[i * 4],
    g = img.d[i * 4 + 1],
    b = img.d[i * 4 + 2];
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b);
  if (colour === 'dark') return clamp((75 - mx) / 40, 0, 1);
  const sat = mx > 0 ? (mx - mn) / mx : 0;
  return clamp((mn - 150) / 50, 0, 1) * clamp((0.3 - sat) / 0.15, 0, 1);
}

// the Gold prototype's solved placement: the starting point for every tier
const GOLD_PROTOTYPE_LOGO = {
  mark: {
    k: 0.00873280096338494,
    phi0: 0.09756632946350122,
    m0: 1.1274858307037372,
  },
  word: {
    k: 0.005093366678406627,
    phi0: 0.15996562850272783,
    m0: 0.4789107547843531,
  },
};

function fitLogo(img, g, P, tier, logoAtFor) {
  const { W, H } = img;
  const idx = [],
    like = [];
  for (let i = 0; i < W * H; i++) {
    if (!g.hit[i] || g.y[i] < P.SEAM + 0.04 || img.d[i * 4 + 3] < 250) continue;
    if (g.m[i] < 0.05 || g.m[i] > P.HC + 0.35 || Math.abs(g.phi[i]) > 1.25)
      continue;
    idx.push(i);
    like.push(logoLikeness(img, i, tier.logo));
  }
  const score = (place) => {
    const at = logoAtFor(place);
    let I = 0,
      U = 0;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k];
      const mm = at(g.phi[i], g.m[i]),
        l = like[k];
      I += Math.min(mm, l);
      U += Math.max(mm, l);
    }
    return U > 0 ? I / U : 0;
  };
  const place = JSON.parse(JSON.stringify(GOLD_PROTOTYPE_LOGO));
  place.mark.inflate = 0;
  place.word.inflate = 0;
  const keys = [];
  for (const b of ['mark', 'word'])
    for (const f of ['k', 'phi0', 'm0', 'inflate']) keys.push([b, f]);
  // k relative, others absolute (inflate in viewBox units)
  const step = { k: 0.03, phi0: 0.02, m0: 0.02, inflate: 0.4 };
  const st = {};
  for (const [b, f] of keys) st[b + f] = step[f];
  let best = score(place);
  const start = best;
  for (let round = 0; round < 200; round++) {
    let moved = false;
    for (const [b, f] of keys)
      for (const dir of [1, -1]) {
        const q = JSON.parse(JSON.stringify(place));
        q[b][f] =
          f === 'k'
            ? q[b][f] * (1 + dir * st[b + f])
            : q[b][f] + dir * st[b + f];
        if (f === 'inflate' && (q[b][f] < -1 || q[b][f] > 3)) continue;
        const s = score(q);
        if (s > best) {
          best = s;
          Object.assign(place[b], q[b]);
          moved = true;
        }
      }
    if (!moved) {
      let small = true;
      for (const [b, f] of keys) {
        st[b + f] *= 0.5;
        if (st[b + f] > (f === 'k' ? 2e-4 : 2e-5)) small = false;
      }
      if (small) break;
    }
  }
  return { place, iou: best, startIou: start, pixels: idx.length };
}

// ------------------------------------------------------------------ masks
function dilate(mask, W, H, r) {
  const dist = L.edt(mask, W, H);
  const out = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) out[i] = dist[i] <= r ? 1 : 0;
  return out;
}

// ------------------------------------------------------------------ matcaps
/** Axis frame for binning a normal by its angle round the capsule axis (phi) and t = n . axis. */
function axisFrame(P) {
  const a = P.Y,
    v = [0, 0, 1],
    va = dot(v, a);
  const c = norm([v[0] - a[0] * va, v[1] - a[1] * va, v[2] - a[2] * va]);
  const b = cross(a, c);
  return { a, b, c };
}

/**
 * The cap matcap (linear RGB, N x N) from cap pixels: cylinder profile cyl(phi)
 * and dome table dome(phi, t), as the prototype's build-matcap.cjs, but binned
 * by the view-corrected normal.
 */
function bakeCapMatcap(img, g, P, exclude, sig) {
  const { W, H } = img;
  const F = axisFrame(P);
  const NP = 256,
    NT = 64;
  const cylAcc = new Float64Array(NP * 4),
    domeAcc = new Float64Array(NP * NT * 4);
  const phiBin = (n) =>
    (Math.atan2(dot(n, F.b), dot(n, F.c)) / Math.PI + 0.5) * NP - 0.5;
  let used = 0;
  for (let i = 0; i < W * H; i++) {
    if (
      !g.hit[i] ||
      img.d[i * 4 + 3] < 250 ||
      g.y[i] < P.SEAM + 0.03 ||
      exclude[i]
    )
      continue;
    const n = [g.nc[i * 3], g.nc[i * 3 + 1], g.nc[i * 3 + 2]];
    const rgb = [
      LIN[img.d[i * 4]],
      LIN[img.d[i * 4 + 1]],
      LIN[img.d[i * 4 + 2]],
    ];
    const pb = phiBin(n),
      p0 = Math.floor(pb),
      fp = pb - p0;
    if (g.y[i] <= P.HC) {
      for (const [pp, w] of [
        [p0, 1 - fp],
        [p0 + 1, fp],
      ]) {
        if (pp < 0 || pp >= NP) continue;
        for (let q = 0; q < 3; q++) cylAcc[pp * 4 + q] += rgb[q] * w;
        cylAcc[pp * 4 + 3] += w;
      }
    } else {
      const tb = Math.max(0, dot(n, F.a)) * NT - 0.5,
        t0 = Math.floor(tb),
        ft = tb - t0;
      for (const [pp, wp] of [
        [p0, 1 - fp],
        [p0 + 1, fp],
      ])
        for (const [tt, wt] of [
          [t0, 1 - ft],
          [t0 + 1, ft],
        ]) {
          if (pp < 0 || pp >= NP || tt < 0 || tt >= NT) continue;
          const k = (tt * NP + pp) * 4,
            w = wp * wt;
          for (let q = 0; q < 3; q++) domeAcc[k + q] += rgb[q] * w;
          domeAcc[k + 3] += w;
        }
    }
    used++;
  }
  const cyl = L.fillGrid(cylAcc, NP, 1, sig.cyl);
  const dome = L.fillGrid(domeAcc, NP, NT, sig.dome);
  const disc = (N) => {
    const out = new Float64Array(N * N * 3);
    for (let yy = 0; yy < N; yy++)
      for (let xx = 0; xx < N; xx++) {
        let nx = ((xx + 0.5) / N - 0.5) / L.MATCAP_SCALE,
          ny = (0.5 - (yy + 0.5) / N) / L.MATCAP_SCALE;
        const r2 = nx * nx + ny * ny;
        if (r2 > 1) {
          const r = Math.sqrt(r2);
          nx /= r;
          ny /= r;
        }
        const n = [nx, ny, Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))];
        const pb = phiBin(n),
          tn = dot(n, F.a);
        const cv = L.sampleGrid(cyl, NP, 1, pb, 0);
        const dv = L.sampleGrid(dome, NP, NT, pb, Math.abs(tn) * NT - 0.5);
        const k = L.smooth(0.08, 0.3, Math.abs(tn));
        for (let q = 0; q < 3; q++)
          out[(yy * N + xx) * 3 + q] = cv[q] + (dv[q] - cv[q]) * k;
      }
    return out;
  };
  return { disc, used };
}

/** Bilinear lookup of an 8-bit sRGB matcap at matcap coords (u, v in -1..1), linear result. */
function lookupMatcap(buf, N, ch, u, v) {
  const fx = (u * L.MATCAP_SCALE + 0.5) * N - 0.5,
    fy = (0.5 - v * L.MATCAP_SCALE) * N - 0.5;
  const x0 = clamp(Math.floor(fx), 0, N - 1),
    y0 = clamp(Math.floor(fy), 0, N - 1);
  const x1 = Math.min(N - 1, x0 + 1),
    y1 = Math.min(N - 1, y0 + 1);
  const ax = clamp(fx - x0, 0, 1),
    ay = clamp(fy - y0, 0, 1);
  const out = [0, 0, 0];
  for (let q = 0; q < 3; q++) {
    const p = (x, y) => LIN[buf[(y * N + x) * ch + q]];
    out[q] =
      (p(x0, y0) * (1 - ax) + p(x1, y0) * ax) * (1 - ay) +
      (p(x0, y1) * (1 - ax) + p(x1, y1) * ax) * ay;
  }
  return out;
}

/**
 * The logo's enamel matcap (RGBA, 128): RGB = the logo ink's own colour by
 * normal, from the picture's logo pixels (interior only); A = a specular
 * strength for the raised edge, from the cap's studio highlights (linear).
 */
function bakeLogoMatcap(img, g, cover, capSrgb, capN) {
  const { W, H } = img;
  const NB = 24;
  const acc = new Float64Array(NB * NB * 4);
  let used = 0;
  for (let y = 2; y < H - 2; y++)
    for (let x = 2; x < W - 2; x++) {
      const i = y * W + x;
      if (!g.hit[i] || cover[i] < 0.98) continue;
      if (
        cover[i - 2] < 0.98 ||
        cover[i + 2] < 0.98 ||
        cover[i - 2 * W] < 0.98 ||
        cover[i + 2 * W] < 0.98
      )
        continue;
      const fx = ((g.u[i] + 1) / 2) * NB - 0.5,
        fy = ((1 - g.v[i]) / 2) * NB - 0.5;
      const x0 = Math.floor(fx),
        y0 = Math.floor(fy),
        ax = fx - x0,
        ay = fy - y0;
      const rgb = [
        LIN[img.d[i * 4]],
        LIN[img.d[i * 4 + 1]],
        LIN[img.d[i * 4 + 2]],
      ];
      for (const [xx, wx] of [
        [x0, 1 - ax],
        [x0 + 1, ax],
      ])
        for (const [yy, wy] of [
          [y0, 1 - ay],
          [y0 + 1, ay],
        ]) {
          if (xx < 0 || yy < 0 || xx >= NB || yy >= NB) continue;
          const k = (yy * NB + xx) * 4,
            w = wx * wy;
          for (let q = 0; q < 3; q++) acc[k + q] += rgb[q] * w;
          acc[k + 3] += w;
        }
      used++;
    }
  const grid = L.fillGrid(acc, NB, NB, 1.2);
  // Outside the normals the picture's logo actually covered (a lean looks
  // there), fall back to the ink's median colour instead of the push-pull
  // extrapolation of its edge, which carried sheen out and greyed dark ink.
  const cells = [];
  for (let k = 0; k < NB * NB; k++)
    if (acc[k * 4 + 3] > 0.5)
      cells.push([0, 1, 2].map((q) => acc[k * 4 + q] / acc[k * 4 + 3]));
  cells.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  const median = cells[cells.length >> 1] || [0, 0, 0];
  const covIn = new Float64Array(NB * NB * 3);
  for (let k = 0; k < NB * NB; k++) {
    const c = Math.min(1, acc[k * 4 + 3] / 2);
    covIn[k * 3] = covIn[k * 3 + 1] = covIn[k * 3 + 2] = c;
  }
  const cov = L.blur3(covIn, NB, NB, 1.5);
  for (let k = 0; k < NB * NB; k++) {
    const w = clamp(cov[k * 3] * 1.5, 0, 1);
    for (let q = 0; q < 3; q++)
      grid[k * 3 + q] = median[q] + (grid[k * 3 + q] - median[q]) * w;
  }
  // RGB only (no alpha, so no browser can premultiply it away): the ink's
  // colour in the left half, the specular strength (sRGB-encoded grey, so the
  // GPU's sRGB decode returns it linear) in the right half
  const N = LOGO_MATCAP;
  const out = Buffer.alloc(2 * N * N * 3);
  for (let yy = 0; yy < N; yy++)
    for (let xx = 0; xx < N; xx++) {
      const u = ((xx + 0.5) / N - 0.5) / L.MATCAP_SCALE,
        v = (0.5 - (yy + 0.5) / N) / L.MATCAP_SCALE;
      const c = L.sampleGrid(
        grid,
        NB,
        NB,
        ((u + 1) / 2) * NB - 0.5,
        ((1 - v) / 2) * NB - 0.5,
      );
      const cap = lookupMatcap(capSrgb, capN, 3, u, v);
      const lum = 0.2126 * cap[0] + 0.7152 * cap[1] + 0.0722 * cap[2];
      const spec = clamp((lum - 0.5) / 0.5, 0, 1) ** 1.6;
      const k = (yy * 2 * N + xx) * 3,
        ks = (yy * 2 * N + N + xx) * 3;
      for (let q = 0; q < 3; q++) {
        out[k + q] = toSrgb(c[q]);
        out[ks + q] = toSrgb(spec);
      }
    }
  return { buf: out, used };
}

/** The live glass layer's matcap (RGBA, straight colour sRGB + opacity), from the picture's rim band. */
function bakeGlassMatcap(img, g, P, studioSrgb, studioN, N) {
  const { W, H } = img;
  const NA = 180,
    NR = 24,
    R0 = 0.88;
  const acc = new Float64Array(NA * NR * 4);
  let used = 0;
  for (let i = 0; i < W * H; i++) {
    if (!g.hit[i] || img.d[i * 4 + 3] < 200 || g.y[i] > P.SEAM - 0.05) continue;
    const u = g.u[i],
      v = g.v[i],
      r = Math.hypot(u, v);
    if (r < R0) continue;
    const psi = (Math.atan2(v, u) / (2 * Math.PI) + 0.5) * NA - 0.5;
    const rb = ((r - R0) / (1 - R0)) * NR - 0.5;
    const p0 = Math.floor(psi),
      r0 = Math.floor(rb),
      fp = psi - p0,
      fr = rb - r0;
    const rgb = [
      LIN[img.d[i * 4]],
      LIN[img.d[i * 4 + 1]],
      LIN[img.d[i * 4 + 2]],
    ];
    for (const [pp, wp] of [
      [p0, 1 - fp],
      [p0 + 1, fp],
    ])
      for (const [rr, wr] of [
        [r0, 1 - fr],
        [r0 + 1, fr],
      ]) {
        const P2 = ((pp % NA) + NA) % NA,
          R2 = clamp(rr, 0, NR - 1),
          k = (R2 * NA + P2) * 4,
          w = wp * wr;
        for (let q = 0; q < 3; q++) acc[k + q] += rgb[q] * w;
        acc[k + 3] += w;
      }
    used++;
  }
  const tab = new Float64Array(NA * NR * 3),
    have = new Uint8Array(NA * NR);
  for (let k = 0; k < NA * NR; k++)
    if (acc[k * 4 + 3] > 0.5) {
      have[k] = 1;
      for (let q = 0; q < 3; q++)
        tab[k * 3 + q] = acc[k * 4 + q] / acc[k * 4 + 3];
    }
  for (let rr = 0; rr < NR; rr++)
    for (let pass = 0; pass < NA; pass++) {
      let changed = false;
      for (let pp = 0; pp < NA; pp++) {
        const k = rr * NA + pp;
        if (have[k]) continue;
        const nb = [
          rr * NA + ((pp + 1) % NA),
          rr * NA + ((pp - 1 + NA) % NA),
        ].filter((j) => have[j] === 1 || have[j] === 2);
        if (!nb.length) continue;
        for (let q = 0; q < 3; q++)
          tab[k * 3 + q] =
            nb.reduce((s, j) => s + tab[j * 3 + q], 0) / nb.length;
        have[k] = 3;
        changed = true;
      }
      for (let k = 0; k < NA * NR; k++) if (have[k] === 3) have[k] = 2;
      if (!changed) break;
    }
  const sm = new Float64Array(tab.length);
  for (let rr = 0; rr < NR; rr++)
    for (let pp = 0; pp < NA; pp++)
      for (let q = 0; q < 3; q++) {
        let s = 0,
          n = 0;
        for (let dp = -3; dp <= 3; dp++)
          for (let dr = -1; dr <= 1; dr++) {
            const R2 = rr + dr;
            if (R2 < 0 || R2 >= NR) continue;
            s += tab[(R2 * NA + ((pp + dp + NA) % NA)) * 3 + q];
            n++;
          }
        sm[(rr * NA + pp) * 3 + q] = s / n;
      }
  const out = Buffer.alloc(N * N * 4);
  for (let yy = 0; yy < N; yy++)
    for (let xx = 0; xx < N; xx++) {
      const nx = ((xx + 0.5) / N - 0.5) / L.MATCAP_SCALE,
        ny = (0.5 - (yy + 0.5) / N) / L.MATCAP_SCALE;
      const r = Math.min(1, Math.hypot(nx, ny));
      const st = lookupMatcap(studioSrgb, studioN, 3, nx, ny);
      const Ls = 0.2126 * st[0] + 0.7152 * st[1] + 0.0722 * st[2];
      const fres = 0.06 + 0.5 * (1 - Math.sqrt(Math.max(0, 1 - r * r))) ** 3;
      const refl = Math.min(1, Ls * 1.6) * fres;
      let rgb = [refl, refl * 0.98, refl * 0.95],
        a = Math.min(1, refl * 0.9);
      const ar = L.smooth(0.9, 0.94, r);
      if (r >= R0) {
        const psi = (Math.atan2(ny, nx) / (2 * Math.PI) + 0.5) * NA - 0.5,
          rb = ((r - R0) / (1 - R0)) * NR - 0.5;
        const p0 = Math.floor(psi),
          fp = psi - p0,
          r0 = clamp(Math.floor(rb), 0, NR - 1),
          r1 = Math.min(NR - 1, r0 + 1),
          fr = clamp(rb - r0, 0, 1);
        const at = (pp, rr, q) =>
          sm[(rr * NA + (((pp % NA) + NA) % NA)) * 3 + q];
        const c = [0, 1, 2].map(
          (q) =>
            (at(p0, r0, q) * (1 - fp) + at(p0 + 1, r0, q) * fp) * (1 - fr) +
            (at(p0, r1, q) * (1 - fp) + at(p0 + 1, r1, q) * fp) * fr,
        );
        rgb = rgb.map((v, q) => v * (1 - ar) + c[q] * ar);
        a = a * (1 - ar) + ar;
      }
      const k = (yy * N + xx) * 4;
      const straight = a > 1e-4 ? rgb.map((v) => v / a) : rgb;
      for (let q = 0; q < 3; q++) out[k + q] = toSrgb(Math.min(1, straight[q]));
      out[k + 3] = Math.round(255 * a);
    }
  return { buf: out, used };
}

// ------------------------------------------------------------------ crops
function bboxOf(W, H, test, pad) {
  let x0 = W,
    y0 = H,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      if (test(y * W + x)) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  return {
    x0: Math.max(0, x0 - pad),
    y0: Math.max(0, y0 - pad),
    x1: Math.min(W, x1 + 1 + pad),
    y1: Math.min(H, y1 + 1 + pad),
  };
}

/**
 * The glitter's albedo ratio: picture / (cap matcap at the pixel's normal),
 * stored as sRGB(ratio / DETAIL_SCALE). Under the logo (dilated) the stones
 * are copied from glitter nearby along the cap (a fixed set of offsets), so the
 * open line art of the mark shows stones, not a blur.
 */
function bakeDetail(img, g, P, capSrgb, capN, logoBand, M) {
  const { W, H } = img;
  const isCap = (i) =>
    g.hit[i] && img.d[i * 4 + 3] >= 250 && g.y[i] >= P.SEAM - 0.02;
  const rect = bboxOf(W, H, isCap, 4);
  const ratio = new Float32Array(W * H * 3).fill(1);
  const ok = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!isCap(i)) continue;
    const mc = lookupMatcap(capSrgb, capN, 3, g.u[i], g.v[i]);
    for (let q = 0; q < 3; q++)
      ratio[i * 3 + q] = clamp(
        LIN[img.d[i * 4 + q]] / Math.max(1e-3, mc[q]),
        0,
        DETAIL_SCALE,
      );
    if (!logoBand[i]) ok[i] = 1;
  }
  const [ax, ay] = M.axisUp,
    px = -ay,
    py = ax;
  const offs = [];
  for (const [a, b] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
    [2, 0],
    [-2, 0],
    [0, 2],
    [0, -2],
    [2, 1],
    [-2, 1],
    [2, -1],
    [-2, -1],
    [3, 0],
    [-3, 0],
    [0, 3],
  ])
    offs.push([
      Math.round((a * px + b * ax) * 64),
      Math.round((a * py + b * ay) * 64),
    ]);
  let filled = 0,
    unfilled = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!isCap(i) || ok[i]) continue;
      let done = false;
      for (const [dx, dy] of offs) {
        const xx = x + dx,
          yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const j = yy * W + xx;
        if (!ok[j]) continue;
        for (let q = 0; q < 3; q++) ratio[i * 3 + q] = ratio[j * 3 + q];
        done = true;
        break;
      }
      if (done) filled++;
      else unfilled++;
    }
  const w = rect.x1 - rect.x0,
    h = rect.y1 - rect.y0;
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y + rect.y0) * W + (x + rect.x0),
        k = (y * w + x) * 3;
      for (let q = 0; q < 3; q++)
        out[k + q] = toSrgb(ratio[i * 3 + q] / DETAIL_SCALE);
    }
  return { buf: out, w, h, rect, filled, unfilled };
}

// ------------------------------------------------------------------ files
async function writeWebp(pipeline, file, opts) {
  await pipeline.webp(opts).toFile(file);
  const meta = await sharp(file).metadata();
  return {
    file,
    width: meta.width,
    height: meta.height,
    bytes: fs.statSync(file).size,
    hash: sha8(fs.readFileSync(file)),
  };
}
const LOSSLESS = { lossless: true, exact: true, effort: 6 };
const LOSSY = { quality: 90, effort: 6 };

async function buildLogoAtlas(Lp, blocks) {
  const out = {};
  const sdf = {};
  for (const b of ['mark', 'word']) {
    const r = await L.rasterBlock(Lp, b, blocks[b].box, HI_PPU);
    sdf[b] = { r, s: L.signedDistance(r) };
  }
  for (const res of ['full', 'half']) {
    const ppu = SDF_PPU[res];
    const dims = Object.fromEntries(
      ['word', 'mark'].map((b) => {
        const B = blocks[b].box;
        return [
          b,
          {
            w: Math.round((B.x1 - B.x0) * ppu),
            h: Math.round((B.y1 - B.y0) * ppu),
          },
        ];
      }),
    );
    const pad = 2;
    const W = dims.word.w + pad + dims.mark.w,
      H = Math.max(dims.word.h, dims.mark.h);
    const buf = Buffer.alloc(W * H, 0);
    const rects = {};
    let x0 = 0;
    for (const b of ['word', 'mark']) {
      const { r, s } = sdf[b],
        B = blocks[b].box,
        d = dims[b];
      for (let y = 0; y < d.h; y++)
        for (let x = 0; x < d.w; x++) {
          // the distance at this atlas texel's centre, from the hi-res field
          const X = B.x0 + ((x + 0.5) / d.w) * (B.x1 - B.x0),
            Y = B.y0 + ((y + 0.5) / d.h) * (B.y1 - B.y0);
          const fx = clamp((X - B.x0) * r.ppu - 0.5, 0, r.w - 1.001),
            fy = clamp((Y - B.y0) * r.ppu - 0.5, 0, r.h - 1.001);
          const ix = Math.floor(fx),
            iy = Math.floor(fy),
            axx = fx - ix,
            ayy = fy - iy,
            k = iy * r.w + ix;
          const v =
            (s[k] * (1 - axx) + s[k + 1] * axx) * (1 - ayy) +
            (s[k + r.w] * (1 - axx) + s[k + r.w + 1] * axx) * ayy;
          buf[y * W + x0 + x] = Math.round(
            255 * clamp(0.5 + v / (2 * SDF_RANGE), 0, 1),
          );
        }
      // normalised atlas rect, v from the TOP of the image (the shader flips)
      rects[b] = [x0 / W, 0, d.w / W, d.h / H];
      x0 += d.w + pad;
    }
    const dir = path.join(PUBLIC, 'capsule-logo');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(
      dir,
      res === 'half' ? 'logo-sdf-half.webp' : 'logo-sdf.webp',
    );
    const info = await writeWebp(
      sharp(buf, { raw: { width: W, height: H, channels: 1 } }),
      file,
      LOSSLESS,
    );
    out[res] = { info, rects };
  }
  return out;
}

async function buildTier(t, Lp, blocks, hi, logoAtFor) {
  const fitJson = JSON.parse(
    fs.readFileSync(path.join(RESEARCH, `${t.name}-fit.json`), 'utf8'),
  );
  const img = await L.readRgba(L.pictureFile(t));
  const { W, H } = img;
  const P = L.restPose(fitJson.fit);
  const t0 = Date.now();
  const g = pixelGeometry(img, P);
  // logo placement
  const lf = fitLogo(img, g, P, t, logoAtFor);
  const at = logoAtFor(lf.place);
  const cover = new Float32Array(W * H);
  const inkMask = new Uint8Array(W * H),
    likeMask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    if (!g.hit[i]) continue;
    cover[i] = at(g.phi[i], g.m[i]);
    if (cover[i] > 0.02) inkMask[i] = 1;
    if (
      g.y[i] > P.SEAM + 0.04 &&
      g.m[i] > 0.05 &&
      Math.abs(g.phi[i]) < 1.25 &&
      logoLikeness(img, i, t.logo) > 0.35
    )
      likeMask[i] = 1;
  }
  // matcap exclusion: the fitted logo plus 7 px (its edge, shadow and any
  // misfit), and logo-coloured pixels near it plus 4 px
  const nearLogo = L.edt(inkMask, W, H);
  for (let i = 0; i < W * H; i++)
    if (likeMask[i] && nearLogo[i] > 40) likeMask[i] = 0;
  const ex1 = dilate(inkMask, W, H, 7),
    ex2 = dilate(likeMask, W, H, 4);
  const exclude = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) exclude[i] = ex1[i] || ex2[i] ? 1 : 0;
  await overlay(img, fitJson, path.join(RESEARCH, `${t.name}-overlay.png`), at);

  // cap matcap
  const glitter = t.cap === 'glitter';
  const cm = bakeCapMatcap(
    img,
    g,
    P,
    exclude,
    glitter ? { cyl: 3, dome: 3 } : { cyl: 1.2, dome: 1.5 },
  );
  const dir = path.join(PUBLIC, t.id);
  fs.mkdirSync(dir, { recursive: true });
  const files = { full: {}, half: {} };
  const capFull = L.linToSrgbBuf(
    cm.disc(MATCAP.full),
    MATCAP.full * MATCAP.full,
  );
  files.full.capMatcap = await writeWebp(
    L.raw3(capFull, MATCAP.full, MATCAP.full),
    path.join(dir, 'cap-matcap.webp'),
    LOSSLESS,
  );
  const capHalf = L.linToSrgbBuf(
    cm.disc(MATCAP.half),
    MATCAP.half * MATCAP.half,
  );
  files.half.capMatcap = await writeWebp(
    L.raw3(capHalf, MATCAP.half, MATCAP.half),
    path.join(dir, 'cap-matcap-half.webp'),
    LOSSLESS,
  );
  // the studio for the glass reflections: the cap matcap's light, blurred for glitter
  let studio = capFull;
  if (glitter) {
    const lin = new Float64Array(MATCAP.full * MATCAP.full * 3);
    for (let i = 0; i < lin.length; i++) lin[i] = LIN[capFull[i]];
    studio = L.linToSrgbBuf(
      L.blur3(lin, MATCAP.full, MATCAP.full, 8),
      MATCAP.full * MATCAP.full,
    );
  }
  // logo enamel
  const lm = bakeLogoMatcap(img, g, cover, capFull, MATCAP.full);
  files.full.logoMatcap = await writeWebp(
    L.raw3(lm.buf, 2 * LOGO_MATCAP, LOGO_MATCAP),
    path.join(dir, 'logo-matcap.webp'),
    LOSSLESS,
  );
  files.half.logoMatcap = files.full.logoMatcap;
  // glass
  const gmFull = bakeGlassMatcap(img, g, P, studio, MATCAP.full, MATCAP.full);
  files.full.glassMatcap = await writeWebp(
    L.raw4(gmFull.buf, MATCAP.full, MATCAP.full),
    path.join(dir, 'glass-matcap.webp'),
    LOSSLESS,
  );
  const gmHalf = bakeGlassMatcap(img, g, P, studio, MATCAP.full, MATCAP.half);
  files.half.glassMatcap = await writeWebp(
    L.raw4(gmHalf.buf, MATCAP.half, MATCAP.half),
    path.join(dir, 'glass-matcap-half.webp'),
    LOSSLESS,
  );
  // contents: the picture's glass half, flattened on the page colour
  const cr = bboxOf(W, H, (i) => g.hit[i] && g.y[i] < P.SEAM + 0.12, 6);
  const flat = await sharp(L.pictureFile(t))
    .flatten({ background: '#0a0a0a' })
    .extract({
      left: cr.x0,
      top: cr.y0,
      width: cr.x1 - cr.x0,
      height: cr.y1 - cr.y0,
    })
    .png()
    .toBuffer();
  files.full.contents = await writeWebp(
    sharp(flat),
    path.join(dir, 'contents.webp'),
    LOSSY,
  );
  const cw = cr.x1 - cr.x0,
    ch = cr.y1 - cr.y0;
  files.half.contents = await writeWebp(
    sharp(flat).resize(Math.round(cw / 2), Math.round(ch / 2), {
      kernel: 'lanczos3',
    }),
    path.join(dir, 'contents-half.webp'),
    LOSSY,
  );
  // glitter detail
  let detailRect = null,
    detailInfo = null;
  if (glitter) {
    const band = dilate(inkMask, W, H, 3);
    const dt = bakeDetail(
      img,
      g,
      P,
      capFull,
      MATCAP.full,
      band,
      fitJson.measure,
    );
    // desktop at 0.8 of the picture's scale: at full scale Diamond's total
    // (10.6 MB) is over the 10 MB desktop budget; 0.8 keeps every stone
    // (stones are 4-8 px in the picture) and still out-resolves the homepage
    files.full.detail = await writeWebp(
      L.raw3(dt.buf, dt.w, dt.h).resize(
        Math.round(dt.w * DETAIL_FULL_SCALE),
        Math.round(dt.h * DETAIL_FULL_SCALE),
        { kernel: 'lanczos3' },
      ),
      path.join(dir, 'detail.webp'),
      LOSSY,
    );
    files.half.detail = await writeWebp(
      L.raw3(dt.buf, dt.w, dt.h).resize(
        Math.round(dt.w / 2),
        Math.round(dt.h / 2),
        { kernel: 'lanczos3' },
      ),
      path.join(dir, 'detail-half.webp'),
      LOSSY,
    );
    detailRect = [dt.rect.x0 / W, dt.rect.y0 / H, dt.w / W, dt.h / H];
    detailInfo = { filled: dt.filled, unfilled: dt.unfilled };
  }
  const report = {
    tier: t.name,
    seconds: (Date.now() - t0) / 1000,
    logoFit: {
      iou: lf.iou,
      startIou: lf.startIou,
      pixels: lf.pixels,
      place: lf.place,
    },
    capSamples: cm.used,
    logoInkSamples: lm.used,
    rimSamples: gmFull.used,
    detail: detailInfo,
  };
  fs.writeFileSync(
    path.join(RESEARCH, `${t.name}-bake.json`),
    JSON.stringify(report, null, 1),
  );
  console.log(
    t.name,
    JSON.stringify({
      logoIou: +lf.iou.toFixed(4),
      from: +lf.startIou.toFixed(4),
      cap: cm.used,
      ink: lm.used,
      rim: gmFull.used,
      detail: detailInfo,
      s: report.seconds,
    }),
  );
  return {
    tier: t,
    fit: fitJson.fit,
    picture: { width: W, height: H },
    logo: lf.place,
    contentsRect: [cr.x0 / W, cr.y0 / H, cw / W, ch / H],
    detailRect,
    files,
  };
}

// ------------------------------------------------------------------ manifest
const round = (x, d = 6) => Number(x.toFixed(d));
async function writeManifest(tiers, atlas, blocks) {
  const prettier = require(path.join(repo, 'node_modules', 'prettier'));
  const cfg = {
    ...(await prettier.resolveConfig(path.join(MODULE, 'x.ts'))),
    parser: 'typescript',
  };
  const url = (info) =>
    `/${path.relative(path.join(repo, 'public'), info.file).replace(/\\/g, '/')}?v=${info.hash}`;
  const tex = (info) => ({
    url: url(info),
    width: info.width,
    height: info.height,
  });
  const entries = {};
  for (const r of tiers) {
    const files = {};
    for (const res of ['full', 'half']) {
      files[res] = {};
      for (const [k, info] of Object.entries(r.files[res]))
        files[res][k] = tex(info);
    }
    entries[r.tier.id] = {
      tier: r.tier.name,
      picture: r.picture,
      fit: Object.fromEntries(
        Object.entries(r.fit).map(([k, v]) => [k, round(v)]),
      ),
      logo: {
        ink: r.tier.logo,
        mark: Object.fromEntries(
          Object.entries(r.logo.mark).map(([k, v]) => [k, round(v, 7)]),
        ),
        word: Object.fromEntries(
          Object.entries(r.logo.word).map(([k, v]) => [k, round(v, 7)]),
        ),
      },
      cap: r.tier.cap,
      contentsRect: r.contentsRect.map((v) => round(v)),
      detailRect: r.detailRect ? r.detailRect.map((v) => round(v)) : null,
      files,
    };
  }
  const logo = {
    range: SDF_RANGE,
    blocks: Object.fromEntries(
      ['mark', 'word'].map((b) => [
        b,
        {
          box: blocks[b].box,
          cx: round(blocks[b].cx, 4),
          cy: round(blocks[b].cy, 4),
        },
      ]),
    ),
    files: Object.fromEntries(
      ['full', 'half'].map((res) => [
        res,
        {
          ...tex(atlas[res].info),
          rects: Object.fromEntries(
            Object.entries(atlas[res].rects).map(([b, v]) => [
              b,
              v.map((x) => round(x)),
            ]),
          ),
        },
      ]),
    ),
  };
  const src =
    `// GENERATED by scripts/capsule-3d/build-capsule-3d.cjs from each tier's approved\n` +
    `// picture. Do not edit by hand: change the source and re-run it.\n//\n` +
    `// Which capsule packs have a 3D model, their textures (URLs carry a content\n` +
    `// version, ?v=<first 8 hex of the file's sha256>) and the numbers fitted to\n` +
    `// each picture. Data only: no three.js.\n\n` +
    `import type { Capsule3dAssets, Capsule3dLogoAtlas } from './capsule-types';\n\n` +
    `export const CAPSULE_3D_ASSETS: Readonly<Record<string, Capsule3dAssets>> = ${JSON.stringify(entries, null, 2)};\n\n` +
    `export const CAPSULE_LOGO_ATLAS: Capsule3dLogoAtlas = ${JSON.stringify(logo, null, 2)};\n`;
  fs.writeFileSync(
    path.join(MODULE, 'capsule-manifest.ts'),
    await prettier.format(src, cfg),
  );
}

(async () => {
  fs.mkdirSync(MODULE, { recursive: true });
  const Lp = L.logoPaths();
  const blocks = L.logoBlocks(Lp);
  const hi = {};
  for (const b of ['mark', 'word']) {
    const r = await L.rasterBlock(Lp, b, blocks[b].box, HI_PPU);
    hi[b] = { r, s: L.signedDistance(r) };
  }
  const logoAtFor = makeLogoAt(blocks, hi);
  const atlas = await buildLogoAtlas(Lp, blocks);
  const only = process.argv.slice(2);
  const done = [];
  for (const t of TIERS) {
    if (only.length && !only.includes(t.name)) continue;
    done.push(await buildTier(t, Lp, blocks, hi, logoAtFor));
  }
  if (only.length) {
    console.log('partial run: manifest not written');
    return;
  }
  await writeManifest(done, atlas, blocks);
  console.log('ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

module.exports = { DETAIL_SCALE, SDF_RANGE };
void toLin;
