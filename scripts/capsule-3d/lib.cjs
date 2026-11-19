/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS script: require() is its only import form */
// Shared maths for the capsule asset scripts (scripts/capsule-3d/).
//
// Units: the capsule radius R = 1. The capsule's local frame: axis +y (cap up),
// the camera-facing meridian is about +z at the rest pose, azimuth phi runs
// from +z toward +x, and the meridian coordinate m is y on the cylinder,
// continuing as arc length over the dome (m = HC + angle) above y = HC.
// Camera space (the approved picture's camera): at the origin, looking down -z,
// vertical field of view F, y up.
//
// Every number here is measured from the tier's own approved picture; nothing
// is drawn or generated except the logo, which is rasterised from the site's
// own vector paths (src/components/brand/polycards-logo-paths.ts).

const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..', '..');
const sharp = require(path.join(repo, 'node_modules', 'sharp'));
const deg = Math.PI / 180;

/** The five capsule packs (ids = the /slots/<slug> slugs on the Poly tab). */
const TIERS = [
  {
    id: 'lucky-pack',
    name: 'bronze',
    picture: 'capsulebronze-pack.webp',
    logo: 'white',
    cap: 'metal',
  },
  {
    id: 'silver-capsule',
    name: 'silver',
    picture: 'capsulesilver-pack.webp',
    logo: 'dark',
    cap: 'metal',
  },
  {
    id: 'gold-capsule',
    name: 'gold',
    picture: 'capsulegold-pack.webp',
    logo: 'dark',
    cap: 'metal',
  },
  {
    id: 'platinum-capsule',
    name: 'platinum',
    picture: 'capsuleplatinum-pack.webp',
    logo: 'white',
    cap: 'metal',
  },
  {
    id: 'diamond-capsule',
    name: 'diamond',
    picture: 'capsulediamond-pack.webp',
    logo: 'dark',
    cap: 'glitter',
  },
];
const pictureFile = (t) =>
  path.join(repo, 'public/images/polycards', t.picture);

const toLin = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const LIN = new Float64Array(256).map((_, i) => toLin(i));
const toSrgb = (c) => {
  c = Math.max(0, Math.min(1, c));
  return Math.round(
    255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055),
  );
};
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a) => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (e0, e1, x) => {
  const k = clamp((x - e0) / (e1 - e0), 0, 1);
  return k * k * (3 - 2 * k);
};

async function readRgba(file) {
  const { data, info } = await sharp(file)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { d: data, W: info.width, H: info.height };
}

/**
 * The rest pose in R = 1 units from a fit: camera-space axes of the capsule's
 * local x, y, z (rig rotation Rz(roll) * Rx(-elev), as three.js Euler 'ZXY'
 * with y = 0), its centre C, the cylinder half-length HC and the seam's y.
 */
function restPose(fit) {
  const ce = Math.cos(fit.elev * deg),
    se = Math.sin(fit.elev * deg);
  const cr = Math.cos(fit.roll * deg),
    sr = Math.sin(fit.roll * deg);
  return {
    F: fit.F,
    C: [fit.tx, fit.ty, -fit.D],
    HC: fit.HC,
    SEAM: fit.SEAM,
    X: [cr, sr, 0],
    Y: [-sr * ce, cr * ce, -se],
    Z: [-sr * se, cr * se, ce],
  };
}

/** Camera ray through pixel centre (x, y) of a W x H picture. */
function rayAt(P, W, H, x, y) {
  const t = Math.tan((P.F * deg) / 2),
    asp = W / H;
  return norm([((2 * x) / W - 1) * t * asp, (1 - (2 * y) / H) * t, -1]);
}

/** Ray from the origin along d against the pill (radius 1). { t, p, n (camera), y (local axial) } or null. */
function hitPill(P, d, R = 1) {
  const a = P.Y,
    oc = [-P.C[0], -P.C[1], -P.C[2]];
  let best = null;
  const da = dot(d, a),
    oa = dot(oc, a);
  const dd = [d[0] - a[0] * da, d[1] - a[1] * da, d[2] - a[2] * da];
  const oo = [oc[0] - a[0] * oa, oc[1] - a[1] * oa, oc[2] - a[2] * oa];
  const A = dot(dd, dd),
    B = 2 * dot(dd, oo),
    Cc = dot(oo, oo) - R * R;
  const disc = B * B - 4 * A * Cc;
  if (disc >= 0) {
    const t = (-B - Math.sqrt(disc)) / (2 * A);
    const y = oa + t * da;
    if (t > 0 && Math.abs(y) <= P.HC) {
      best = {
        t,
        n: [
          oc[0] + d[0] * t - a[0] * y,
          oc[1] + d[1] * t - a[1] * y,
          oc[2] + d[2] * t - a[2] * y,
        ],
        y,
      };
    }
  }
  for (const sgn of [1, -1]) {
    const S = [
      P.C[0] + a[0] * P.HC * sgn,
      P.C[1] + a[1] * P.HC * sgn,
      P.C[2] + a[2] * P.HC * sgn,
    ];
    const os = [-S[0], -S[1], -S[2]];
    const b = dot(os, d),
      c = dot(os, os) - R * R,
      h = b * b - c;
    if (h < 0) continue;
    const t = -b - Math.sqrt(h);
    if (t <= 0 || (best && t >= best.t)) continue;
    const hp = [d[0] * t - S[0], d[1] * t - S[1], d[2] * t - S[2]];
    const y = sgn * P.HC + dot(hp, a);
    if (sgn * (y - sgn * P.HC) < 0) continue;
    best = { t, n: hp, y };
  }
  if (best) {
    best.n = norm(best.n);
    best.p = [d[0] * best.t, d[1] * best.t, d[2] * best.t];
  }
  return best;
}

/** Camera-space point -> the capsule's local frame. */
function toLocal(P, p) {
  const q = [p[0] - P.C[0], p[1] - P.C[1], p[2] - P.C[2]];
  return [dot(q, P.X), dot(q, P.Y), dot(q, P.Z)];
}
/** Local point -> camera space. */
function toCamera(P, l) {
  return [
    P.C[0] + P.X[0] * l[0] + P.Y[0] * l[1] + P.Z[0] * l[2],
    P.C[1] + P.X[1] * l[0] + P.Y[1] * l[1] + P.Z[1] * l[2],
    P.C[2] + P.X[2] * l[0] + P.Y[2] * l[1] + P.Z[2] * l[2],
  ];
}
/** Camera-space point -> picture px. */
function project(P, W, H, c) {
  const t = Math.tan((P.F * deg) / 2),
    z = -c[2];
  return [
    ((c[0] / z / (t * (W / H)) + 1) * W) / 2,
    ((1 - c[1] / z / t) * H) / 2,
  ];
}
/** Local point -> (phi, m) on the cap's parametrisation. */
function phiM(P, l) {
  const phi = Math.atan2(l[0], l[2]);
  if (l[1] <= P.HC) return [phi, l[1]];
  return [phi, P.HC + Math.atan2(l[1] - P.HC, Math.hypot(l[0], l[2]))];
}

/**
 * The view-corrected matcap coordinate (three.js MeshMatcapMaterial): the
 * normal expressed in a frame built from the direction to the camera, so a
 * capsule off the screen's centre keeps its rim on the outline. viewDir points
 * from the surface toward the camera. Returns [u, v] in -1..1 (the texture
 * coordinate is u * 0.495 + 0.5, as in three.js).
 */
function matcapUV(n, viewDir) {
  const x = norm([viewDir[2], 0, -viewDir[0]]);
  const y = cross(viewDir, x);
  return [dot(x, n), dot(y, n)];
}
const MATCAP_SCALE = 0.495;

/** Push-pull fill + separable gaussian on a GW x GH grid of [r,g,b,w] sums (prototype build-matcap.cjs). */
function fillGrid(acc, GW, GH, sig, wrapX = false) {
  const n = GW * GH;
  const L = {
    w: GW,
    h: GH,
    c: new Float64Array(n * 3),
    m: new Float64Array(n),
  };
  for (let k = 0; k < n; k++) {
    const w = acc[k * 4 + 3];
    L.m[k] = Math.min(1, w / 2);
    if (w > 0) for (let q = 0; q < 3; q++) L.c[k * 3 + q] = acc[k * 4 + q] / w;
  }
  const pyr = [L];
  while (pyr[pyr.length - 1].w > 1 || pyr[pyr.length - 1].h > 1) {
    const U = pyr[pyr.length - 1],
      w2 = Math.max(1, U.w >> 1),
      h2 = Math.max(1, U.h >> 1);
    const cc = new Float64Array(w2 * h2 * 3),
      mm = new Float64Array(w2 * h2);
    for (let y = 0; y < h2; y++)
      for (let x = 0; x < w2; x++) {
        let ws = 0;
        const cs = [0, 0, 0];
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const xx = Math.min(U.w - 1, 2 * x + dx),
              yy = Math.min(U.h - 1, 2 * y + dy),
              k = yy * U.w + xx;
            ws += U.m[k];
            for (let q = 0; q < 3; q++) cs[q] += U.c[k * 3 + q] * U.m[k];
          }
        const k2 = y * w2 + x;
        mm[k2] = Math.min(1, ws);
        if (ws > 0) for (let q = 0; q < 3; q++) cc[k2 * 3 + q] = cs[q] / ws;
      }
    pyr.push({ w: w2, h: h2, c: cc, m: mm });
  }
  for (let li = pyr.length - 2; li >= 0; li--) {
    const A = pyr[li],
      U = pyr[li + 1];
    for (let y = 0; y < A.h; y++)
      for (let x = 0; x < A.w; x++) {
        const k = y * A.w + x;
        const fx = clamp(((x + 0.5) * U.w) / A.w - 0.5, 0, U.w - 1),
          fy = clamp(((y + 0.5) * U.h) / A.h - 0.5, 0, U.h - 1);
        const x0 = Math.floor(fx),
          y0 = Math.floor(fy),
          x1 = Math.min(U.w - 1, x0 + 1),
          y1 = Math.min(U.h - 1, y0 + 1);
        const ax = fx - x0,
          ay = fy - y0;
        for (let q = 0; q < 3; q++) {
          const up =
            (U.c[(y0 * U.w + x0) * 3 + q] * (1 - ax) +
              U.c[(y0 * U.w + x1) * 3 + q] * ax) *
              (1 - ay) +
            (U.c[(y1 * U.w + x0) * 3 + q] * (1 - ax) +
              U.c[(y1 * U.w + x1) * 3 + q] * ax) *
              ay;
          A.c[k * 3 + q] = A.c[k * 3 + q] * A.m[k] + up * (1 - A.m[k]);
        }
        A.m[k] = 1;
      }
  }
  return blur3(pyr[0].c, GW, GH, sig, wrapX);
}

/** Separable gaussian over an interleaved RGB Float64Array. */
function blur3(src, GW, GH, sig, wrapX = false) {
  if (!(sig > 0)) return Float64Array.from(src);
  const R2 = Math.ceil(sig * 3),
    g = [];
  for (let i = -R2; i <= R2; i++) g.push(Math.exp(-(i * i) / (2 * sig * sig)));
  const gs = g.reduce((p, q) => p + q, 0);
  const tmp = new Float64Array(src.length),
    out = new Float64Array(src.length);
  const xi = (x) => (wrapX ? ((x % GW) + GW) % GW : clamp(x, 0, GW - 1));
  for (let y = 0; y < GH; y++)
    for (let x = 0; x < GW; x++)
      for (let q = 0; q < 3; q++) {
        let s = 0;
        for (let i = -R2; i <= R2; i++)
          s += src[(y * GW + xi(x + i)) * 3 + q] * g[i + R2];
        tmp[(y * GW + x) * 3 + q] = s / gs;
      }
  for (let y = 0; y < GH; y++)
    for (let x = 0; x < GW; x++)
      for (let q = 0; q < 3; q++) {
        let s = 0;
        for (let i = -R2; i <= R2; i++)
          s += tmp[(clamp(y + i, 0, GH - 1) * GW + x) * 3 + q] * g[i + R2];
        out[(y * GW + x) * 3 + q] = s / gs;
      }
  return out;
}

/** Bilinear sample of an interleaved RGB grid at fractional cell coords. */
function sampleGrid(arr, GW, GH, fx, fy, wrapX = false) {
  fy = clamp(fy, 0, GH - 1);
  if (!wrapX) fx = clamp(fx, 0, GW - 1);
  const x0 = Math.floor(fx),
    y0 = Math.floor(fy);
  const ax = fx - x0,
    ay = fy - y0;
  const X = (x) => (wrapX ? ((x % GW) + GW) % GW : clamp(x, 0, GW - 1));
  const xa = X(x0),
    xb = X(x0 + 1),
    y1 = Math.min(GH - 1, y0 + 1);
  const out = [0, 0, 0];
  for (let q = 0; q < 3; q++)
    out[q] =
      (arr[(y0 * GW + xa) * 3 + q] * (1 - ax) +
        arr[(y0 * GW + xb) * 3 + q] * ax) *
        (1 - ay) +
      (arr[(y1 * GW + xa) * 3 + q] * (1 - ax) +
        arr[(y1 * GW + xb) * 3 + q] * ax) *
        ay;
  return out;
}

// ------------------------------------------------------------------ the logo
/** The logo paths, read from the site's own TypeScript module. */
function logoPaths() {
  const ts = require(path.join(repo, 'node_modules', 'typescript'));
  const file = path.join(repo, 'src/components/brand/polycards-logo-paths.ts');
  const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const mod = { exports: {} };
  new Function('module', 'exports', js)(mod, mod.exports);
  return mod.exports;
}

/**
 * The logo's two blocks in viewBox units (y down). `box` is the atlas region,
 * `cx`/`cy` the anchor the placement puts at (phi0, m0): the mark's ink centre,
 * the wordmark's horizontal centre on its baseline (as the prototype placed them).
 */
function logoBlocks(L) {
  const sw = L.LOGO_MARK_STROKE.width;
  return {
    mark: {
      box: { x0: -7, y0: 0, x1: 61, y1: 89 },
      cx: (2.28 - sw / 2 + 51.98 + sw / 2) / 2,
      cy: (9.07 - sw / 2 + 80) / 2,
    },
    word: {
      box: { x0: 92, y0: 22, x1: 367, y1: 92 },
      cx: (99.25 + 359.94) / 2,
      cy: 72.33,
    },
  };
}

/** Rasterises one block (alpha 0..1) at `ppu` px per viewBox unit via an SVG. */
async function rasterBlock(L, which, box, ppu) {
  const w = Math.round((box.x1 - box.x0) * ppu),
    h = Math.round((box.y1 - box.y0) * ppu);
  const body =
    which === 'mark'
      ? `<path d="${L.LOGO_MARK}" fill="none" stroke="#fff" stroke-width="${L.LOGO_MARK_STROKE.width}" stroke-linejoin="${L.LOGO_MARK_STROKE.linejoin}" stroke-linecap="${L.LOGO_MARK_STROKE.linecap}"/>`
      : L.LOGO_LETTERS.map(
          (l) => `<path d="${l.d}" fill="#fff" fill-rule="nonzero"/>`,
        ).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${box.x0} ${box.y0} ${box.x1 - box.x0} ${box.y1 - box.y0}">${body}</svg>`;
  const { data } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const a = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = data[i * 4 + 3] / 255;
  return { a, w, h, ppu, box };
}

/** 1-D squared distance transform (Felzenszwalb & Huttenlocher). */
function edt1(f, n, d, v, z) {
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;
  for (let q = 1; q < n; q++) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k--;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
}
/** Euclidean distance (px) from every pixel to the nearest pixel where `on` is set. */
function edt(on, w, h) {
  const INF = 1e20;
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = on[i] ? 0 : INF;
  const n = Math.max(w, h);
  const f = new Float64Array(n),
    d = new Float64Array(n),
    v = new Int32Array(n),
    z = new Float64Array(n + 1);
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = g[y * w + x];
    edt1(f, h, d, v, z);
    for (let y = 0; y < h; y++) g[y * w + x] = d[y];
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = g[y * w + x];
    edt1(f, w, d, v, z);
    for (let x = 0; x < w; x++) g[y * w + x] = Math.sqrt(d[x]);
  }
  return g;
}
/** Signed distance in viewBox units (positive inside) of a rasterised block. */
function signedDistance(r) {
  const n = r.w * r.h,
    inside = new Uint8Array(n),
    outside = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    inside[i] = r.a[i] >= 0.5 ? 1 : 0;
    outside[i] = 1 - inside[i];
  }
  const dIn = edt(outside, r.w, r.h),
    dOut = edt(inside, r.w, r.h);
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++)
    s[i] = (inside[i] ? dIn[i] - 0.5 : -(dOut[i] - 0.5)) / r.ppu;
  return s;
}

// ------------------------------------------------------------------ images
const raw3 = (buf, W, H) =>
  sharp(buf, { raw: { width: W, height: H, channels: 3 } });
const raw4 = (buf, W, H) =>
  sharp(buf, { raw: { width: W, height: H, channels: 4 } });
/** Float RGB (linear) -> 8-bit sRGB buffer. */
function linToSrgbBuf(lin, n) {
  const out = Buffer.alloc(n * 3);
  for (let i = 0; i < n * 3; i++) out[i] = toSrgb(lin[i]);
  return out;
}

module.exports = {
  repo,
  sharp,
  deg,
  TIERS,
  pictureFile,
  toLin,
  LIN,
  toSrgb,
  dot,
  cross,
  norm,
  clamp,
  smooth,
  readRgba,
  restPose,
  rayAt,
  hitPill,
  toLocal,
  toCamera,
  project,
  phiM,
  matcapUV,
  MATCAP_SCALE,
  fillGrid,
  blur3,
  sampleGrid,
  logoPaths,
  logoBlocks,
  rasterBlock,
  edt,
  signedDistance,
  raw3,
  raw4,
  linToSrgbBuf,
};
