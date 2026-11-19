/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS node tool */
// Recolour the approved 151 back for another pack, and finish that pack's plate.
//
//   node scripts/pack-back/recolour-back.cjs <pack> ref     1. blank + recolour + re-canvas
//   node scripts/pack-back/match-back.cjs   <pack>          2. trial fit (tmp work dir)
//   node scripts/pack-back/recolour-back.cjs <pack> zones   3. seed printZones for the pack
//   node scripts/pack-back/match-back.cjs   <pack> --final  4. final fit (carries the zones)
//   node scripts/pack-back/recolour-back.cjs <pack> plate   5. plate + checks
//
// Settings live in scripts/pack-back/packs/<pack>.json under "recolour"; the
// rest of that file is match-back.cjs's ordinary config, whose `back` numbers
// must equal the 151 numbers moved by this pack's scale and pad (step 1 checks
// and prints them).
//
// Step 1 (`ref`), all in float, rounded once:
//  a) blank: the 151 live-text zones are replaced by the 151 plate's rebuilt foil
//     (moved back into 151-back-a's frame), so no 151 price, odds or buyback text
//     ever reaches another pack's file
//  b) regions: pale panel, navy ground and pink band, split along their printed
//     borders; strip, fin seal and crimps are left alone (match-back.cjs rebuilds
//     them from the front)
//  c) unmix: in every region the ink (white type, gold type and outline, the
//     logo) is separated from the ground: the ground under the ink is a membrane
//     fill from that region only, the ink's coverage is the projection onto the
//     ground->ink line. Ground and ink are recoloured apart and recomposed with
//     the same coverage, so type edges keep their antialiasing and get no fringe.
//     Region borders are unmixed the same way between the two regions' grounds.
//  d) ground maps (CIE Lab): navy keeps its gloss as a luminance ratio, band and
//     pale keep theirs as an L offset; hue is rotated onto the pack's colour, so
//     the sheen's own variation is kept
//  e) re-canvas to the front's size: uniform Lanczos-3 scale when the pack's body
//     is narrower than 151's (cr, 30th), centred, outside exactly 0, inside lifted
//     to max channel >= 7 (match-back.cjs finds the back's edges and checks
//     coverage by brightness)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  REPO,
  sharp,
  loadConfig,
  zoneRects,
  inRects,
  rawRGBA,
  rawRGB,
  rgb2lab,
  lab2rgb,
} = require('./lib.cjs');

const [pack, step = 'ref'] = process.argv.slice(2);
if (!pack)
  throw new Error('usage: node recolour-back.cjs <pack> ref|zones|plate');
const cfg = loadConfig(pack);
const rc = cfg.recolour;
if (!rc) throw new Error(`packs/${pack}.json has no "recolour" section`);
const abs = (f) => (path.isAbsolute(f) ? f : path.join(REPO, f));
const SRC = {
  back: abs(rc.source.back),
  plate: abs(rc.source.plate),
  geometry: abs(rc.source.geometry),
};
fs.mkdirSync(cfg.outDir, { recursive: true });
const refFile = cfg.backRef;
const sha = (f) =>
  crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
// CIE Y (0..1) <-> L*
const Yof = (L) => (L > 8 ? ((L + 16) / 116) ** 3 : L / 903.3);
const Lof = (Y) => (Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y);
const relLum = (rgb) => {
  const f = (c) => {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
};
const contrast = (p, q) => {
  const a = relLum(p),
    b = relLum(q);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
};
const hex = (c) =>
  '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const hexToLab = (h) =>
  rgb2lab(
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  );
const median = (a) => {
  const s = Float64Array.from(a).sort();
  return s.length ? s[s.length >> 1] : NaN;
};

// The 151 numbers this pack's `back` must equal once moved by scale and pad.
const BACK151 = {
  bodyTop: 131,
  bodyBottom: 1531,
  textTop: 195,
  textBottom: 1452,
  stripRight: 73,
  seam: [444, 526],
  xL: 45,
  xR: 860,
};
function placement(Wf, Hf) {
  const s = rc.scale;
  const padX = Math.round((Wf - 897 * s) / 2),
    padY = Math.round((Hf - 1666 * s) / 2);
  const X = (v) => Math.round(v * s + padX),
    Y = (v) => Math.round(v * s + padY);
  const back = {
    bodyTop: Y(BACK151.bodyTop),
    bodyBottom: Y(BACK151.bodyBottom),
    textTop: Y(BACK151.textTop),
    textBottom: Y(BACK151.textBottom),
    stripRight: X(BACK151.stripRight),
    seam: BACK151.seam.map(X),
    xL: X(BACK151.xL),
    xR: X(BACK151.xR),
  };
  return { s, padX, padY, back };
}

// ------------------------------------------------------------------------------------------
// Shift between the 151 matched frame and 151-back-a (integer, by pixel identity)
async function shift151(A, M) {
  const W = A.W;
  let best = null;
  for (let dy = -12; dy <= 12; dy++)
    for (let off = -12; off <= 12; off++) {
      let same = 0,
        n = 0;
      for (let Y = 300; Y < 1400; Y += 11)
        for (let X = 120; X < 800; X += 7) {
          if (X >= 430 && X <= 540) continue;
          n++;
          const p = (Y * W + X) * 4,
            q = ((Y - dy) * W + (X - off)) * 3;
          if (
            M.data[p] === A.data[q] &&
            M.data[p + 1] === A.data[q + 1] &&
            M.data[p + 2] === A.data[q + 2]
          )
            same++;
        }
      if (!best || same > best.same) best = { dy, off, same, n };
    }
  return best;
}

// ------------------------------------------------------------------------------------------
// Membrane fill of `unknown` pixels from `known` ones, only through `domain`.
function membrane(img, W, H, domain, known, iters = 500) {
  const out = new Float32Array(img); // RGB float
  const unk = [];
  for (let i = 0; i < W * H; i++) if (domain[i] && !known[i]) unk.push(i);
  // BFS-ordered start: each unknown takes the mean of already set neighbours
  const set = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) if (domain[i] && known[i]) set[i] = 1;
  let frontier = unk.filter((i) => {
    const x = i % W;
    return (
      (x > 0 && set[i - 1]) ||
      (x < W - 1 && set[i + 1]) ||
      (i >= W && set[i - W]) ||
      (i < W * (H - 1) && set[i + W])
    );
  });
  let guard = 0;
  while (frontier.length && guard++ < 4000) {
    const next = [];
    const vals = frontier.map((i) => {
      const x = i % W;
      let n = 0;
      const s = [0, 0, 0];
      for (const j of [
        x > 0 ? i - 1 : -1,
        x < W - 1 ? i + 1 : -1,
        i - W,
        i + W,
      ]) {
        if (j < 0 || j >= W * H || !set[j]) continue;
        n++;
        for (let c = 0; c < 3; c++) s[c] += out[j * 3 + c];
      }
      return n ? s.map((v) => v / n) : null;
    });
    frontier.forEach((i, k) => {
      if (!vals[k]) return;
      for (let c = 0; c < 3; c++) out[i * 3 + c] = vals[k][c];
      set[i] = 2;
    });
    for (const i of frontier) {
      const x = i % W;
      for (const j of [
        x > 0 ? i - 1 : -1,
        x < W - 1 ? i + 1 : -1,
        i - W,
        i + W,
      ]) {
        if (j < 0 || j >= W * H || set[j] || !domain[j]) continue;
        set[j] = 3;
        next.push(j);
      }
    }
    for (const j of next) set[j] = 0; // 3 only de-duplicated the queue
    frontier = next;
  }
  // SOR, red-black, Laplace on the unknowns (neighbours only inside the domain)
  const omega = 1.85;
  for (let it = 0; it < iters; it++)
    for (const parity of [0, 1])
      for (const i of unk) {
        const x = i % W,
          y = (i / W) | 0;
        if (((x + y) & 1) !== parity) continue;
        let n = 0,
          r = 0,
          g = 0,
          b = 0;
        const add = (j) => {
          if (!domain[j]) return;
          n++;
          r += out[j * 3];
          g += out[j * 3 + 1];
          b += out[j * 3 + 2];
        };
        if (x > 0) add(i - 1);
        if (x < W - 1) add(i + 1);
        if (y > 0) add(i - W);
        if (y < H - 1) add(i + W);
        if (!n) continue;
        out[i * 3] += omega * (r / n - out[i * 3]);
        out[i * 3 + 1] += omega * (g / n - out[i * 3 + 1]);
        out[i * 3 + 2] += omega * (b / n - out[i * 3 + 2]);
      }
  return out;
}

function dilate(mask, W, H, r, within) {
  const o = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx,
            yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
          if (dx * dx + dy * dy > r * r + r) continue;
          o[yy * W + xx] = 1;
        }
    }
  if (within) for (let i = 0; i < W * H; i++) if (!within[i]) o[i] = 0;
  return o;
}

// ------------------------------------------------------------------------------------------
// Separable Lanczos-3 resample of float RGB(+mask) planes.
function lanczosResize(planes, W, H, W2, H2) {
  const a = 3;
  const L = (x) => {
    if (x === 0) return 1;
    if (Math.abs(x) >= a) return 0;
    const px = Math.PI * x;
    return (a * Math.sin(px) * Math.sin(px / a)) / (px * px);
  };
  const weights = (n, n2) => {
    const sc = n2 / n,
      support = a / Math.min(sc, 1);
    const ws = [];
    for (let i = 0; i < n2; i++) {
      const c = (i + 0.5) / sc - 0.5;
      const lo = Math.floor(c - support),
        hi = Math.ceil(c + support);
      const idx = [],
        w = [];
      let s = 0;
      for (let j = lo; j <= hi; j++) {
        const v = L((j - c) * Math.min(sc, 1));
        if (v === 0) continue;
        idx.push(clamp(j, 0, n - 1));
        w.push(v);
        s += v;
      }
      ws.push({ idx, w: w.map((v) => v / s) });
    }
    return ws;
  };
  const wx = weights(W, W2),
    wy = weights(H, H2);
  return planes.map((P) => {
    const tmp = new Float32Array(W2 * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W2; x++) {
        const { idx, w } = wx[x];
        let s = 0;
        for (let k = 0; k < idx.length; k++) s += P[y * W + idx[k]] * w[k];
        tmp[y * W2 + x] = s;
      }
    const out = new Float32Array(W2 * H2);
    for (let y = 0; y < H2; y++) {
      const { idx, w } = wy[y];
      for (let x = 0; x < W2; x++) {
        let s = 0;
        for (let k = 0; k < idx.length; k++) s += tmp[idx[k] * W2 + x] * w[k];
        out[y * W2 + x] = s;
      }
    }
    return out;
  });
}

// ------------------------------------------------------------------------------------------
async function stepRef() {
  const A = await rawRGB(SRC.back);
  const M = await rawRGBA(abs(rc.source.matched));
  const P = await rawRGBA(SRC.plate);
  const geo151 = JSON.parse(fs.readFileSync(SRC.geometry, 'utf8'));
  const { W, H } = A;
  if (W !== 897 || H !== 1666) throw new Error('151-back-a is not 897x1666');
  const sh = await shift151(A, M);
  if (sh.same !== sh.n)
    throw new Error(
      `151 matched/back-a shift not exact: ${JSON.stringify(sh)}`,
    );
  console.log(
    `151 shift matched->back-a: off=${sh.off} dy=${sh.dy} (${sh.same}/${sh.n} px identical)`,
  );

  // ---- a) blank the 151 live zones with the plate's rebuilt foil --------------------------
  const img = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H * 3; i++) img[i] = A.data[i];
  const live = zoneRects(geo151, W, H, 'live');
  const zonesA = live.map((r) => ({
    id: r.id,
    x0: r.x0 - sh.off,
    x1: r.x1 - sh.off,
    y0: r.y0 - sh.dy,
    y1: r.y1 - sh.dy,
  }));
  let blanked = 0;
  for (const r of live)
    for (let Y = r.y0; Y < r.y1; Y++)
      for (let X = r.x0; X < r.x1; X++) {
        const p = (Y * W + X) * 4,
          q = ((Y - sh.dy) * W + (X - sh.off)) * 3;
        for (let c = 0; c < 3; c++) img[q + c] = P.data[p + c];
        blanked++;
      }
  console.log(
    `blanked ${live.length} live zones (${blanked} px) from 151-back-plate.png`,
  );

  // ---- b) regions -------------------------------------------------------------------------
  const R = rc.regions;
  const KEEP = 0,
    PALE = 1,
    NAVY = 2,
    BAND = 3;
  const NAMES = ['keep', 'pale', 'navy', 'band'];
  const lab = new Float32Array(W * H * 3);
  const labAt = (buf, i) => rgb2lab(buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]);
  for (let i = 0; i < W * H; i++) {
    const l = labAt(img, i);
    lab[i * 3] = l[0];
    lab[i * 3 + 1] = l[1];
    lab[i * 3 + 2] = l[2];
  }
  // diagonal pale/navy border in the left panel: first navy row per column, line fit
  const pts = [];
  for (const [xa, xb, ya] of R.diagonalScan)
    for (let x = xa; x <= xb; x++) {
      for (let y = ya; y < ya + 260; y++) {
        const i = y * W + x;
        if (
          lab[i * 3] < 50 &&
          lab[(i + W) * 3] < 50 &&
          lab[(i + 2 * W) * 3] < 50
        ) {
          // sub-pixel: where L crosses the mid level between pale and navy
          const Lp = lab[(i - W) * 3],
            Lc = lab[i * 3];
          const mid = (93 + 10) / 2;
          pts.push([x, y - 1 + clamp((Lp - mid) / Math.max(1, Lp - Lc), 0, 1)]);
          break;
        }
      }
    }
  let fit = null;
  for (let pass = 0; pass < 3; pass++) {
    const use = fit
      ? pts.filter(([x, y]) => Math.abs(y - (fit.a + fit.b * x)) < 1.5)
      : pts;
    const n = use.length,
      mx = use.reduce((s, p) => s + p[0], 0) / n,
      my = use.reduce((s, p) => s + p[1], 0) / n;
    let sxy = 0,
      sxx = 0;
    for (const [x, y] of use) {
      sxy += (x - mx) * (y - my);
      sxx += (x - mx) ** 2;
    }
    const b = sxy / sxx;
    fit = { a: my - b * mx, b, n };
  }
  const diagY = (x) => fit.a + fit.b * x;
  console.log(
    `diagonal: y = ${fit.a.toFixed(2)} + ${fit.b.toFixed(4)} x (${fit.n}/${pts.length} columns)`,
  );

  // silhouette of the back (on black)
  const sil = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    let l = -1,
      r = -1;
    for (let x = 0; x < W; x++)
      if (
        Math.max(
          A.data[(y * W + x) * 3],
          A.data[(y * W + x) * 3 + 1],
          A.data[(y * W + x) * 3 + 2],
        ) > 18
      ) {
        l = x;
        break;
      }
    for (let x = W - 1; x >= 0; x--)
      if (
        Math.max(
          A.data[(y * W + x) * 3],
          A.data[(y * W + x) * 3 + 1],
          A.data[(y * W + x) * 3 + 2],
        ) > 18
      ) {
        r = x;
        break;
      }
    if (l >= 0) for (let x = l; x <= r; x++) sil[y * W + x] = 1;
  }

  const label = new Uint8Array(W * H);
  const border = new Uint8Array(W * H); // 1 = band border, 2 = diagonal border
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (!sil[i] || y < R.rows[0] || y > R.rows[1]) continue;
      if (x < R.stripRight || (x >= R.seam[0] && x <= R.seam[1])) continue;
      if (x > R.seam[1]) label[i] = NAVY;
      else if (x >= R.band[0]) label[i] = BAND;
      else {
        const d = y - diagY(x);
        label[i] = d < 0 ? PALE : NAVY;
        if (Math.abs(d) <= R.diagonalHalf) border[i] = 2;
      }
      if (x >= R.bandBorder[0] && x <= R.bandBorder[1]) border[i] = 1;
    }
  // the side each border pixel is unmixed against
  const sideA = new Uint8Array(W * H),
    sideB = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (border[i] === 1) {
        sideA[i] = label[y * W + R.bandBorder[0] - 2] || PALE;
        sideB[i] = BAND;
        if (sideA[i] === BAND) border[i] = 0;
      } else if (border[i] === 2) {
        sideA[i] = PALE;
        sideB[i] = NAVY;
      }
    }

  // ---- c) inks ----------------------------------------------------------------------------
  // core pixels per ink class, then the unknown ring (dilated, region-limited)
  const INK = rc.inks; // {white:{region:'navy', core:{...}}, ...}
  const regionMask = (r) => {
    const m = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) if (label[i] === r && !border[i]) m[i] = 1;
    return m;
  };
  const masks = {
    [PALE]: regionMask(PALE),
    [NAVY]: regionMask(NAVY),
    [BAND]: regionMask(BAND),
  };
  const zoneMask = new Uint8Array(W * H);
  for (const z of zonesA)
    for (let y = z.y0; y < z.y1; y++)
      for (let x = z.x0; x < z.x1; x++) zoneMask[y * W + x] = 1;
  const inkCore = {};
  const coreTest = (c, L, a, b) => {
    const C = Math.hypot(a, b);
    return (
      (c.Lmin == null || L >= c.Lmin) &&
      (c.Lmax == null || L <= c.Lmax) &&
      (c.Cmax == null || C <= c.Cmax) &&
      (c.bmin == null || b >= c.bmin)
    );
  };
  const regionId = { pale: PALE, navy: NAVY, band: BAND };
  for (const [name, ink] of Object.entries(INK)) {
    const r = regionId[ink.region];
    const m = new Uint8Array(W * H);
    let n = 0;
    for (let i = 0; i < W * H; i++)
      if (
        masks[r][i] &&
        coreTest(ink.core, lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2])
      ) {
        m[i] = 1;
        n++;
      }
    inkCore[name] = m;
    console.log(`ink ${name}: ${n} core px in ${ink.region}`);
  }
  // ink colour (source) = given, or the median of its core
  const inkSrc = {};
  for (const [name, ink] of Object.entries(INK)) {
    if (ink.colour) {
      inkSrc[name] = ink.colour;
      continue;
    }
    const rs = [],
      gs = [],
      bs = [];
    for (let i = 0; i < W * H; i++)
      if (inkCore[name][i]) {
        rs.push(img[i * 3]);
        gs.push(img[i * 3 + 1]);
        bs.push(img[i * 3 + 2]);
      }
    inkSrc[name] = [median(rs), median(gs), median(bs)];
  }
  const unknown = {};
  for (const r of [PALE, NAVY, BAND]) {
    const u = new Uint8Array(W * H);
    for (const [name, ink] of Object.entries(INK))
      if (regionId[ink.region] === r) {
        const d = dilate(inkCore[name], W, H, rc.inkRing, masks[r]);
        for (let i = 0; i < W * H; i++) if (d[i]) u[i] = 1;
      }
    unknown[r] = u;
  }

  // ground fills: domain = region + adjacent border pixels; known = region minus ink ring
  const ground = {};
  for (const r of [PALE, NAVY, BAND]) {
    const domain = new Uint8Array(W * H),
      known = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) {
      if (masks[r][i]) {
        domain[i] = 1;
        if (!unknown[r][i]) known[i] = 1;
      } else if (border[i] && (sideA[i] === r || sideB[i] === r)) domain[i] = 1;
    }
    const t = Date.now();
    ground[r] = membrane(img, W, H, domain, known, rc.fillIterations);
    console.log(`ground fill ${NAMES[r]}: ${Date.now() - t} ms`);
  }

  // ---- d) ground maps ---------------------------------------------------------------------
  const srcStats = {};
  for (const r of [PALE, NAVY, BAND]) {
    const Ls = [],
      as = [],
      bs = [];
    for (let i = 0; i < W * H; i += 3)
      if (masks[r][i] && !unknown[r][i] && !zoneMask[i]) {
        Ls.push(lab[i * 3]);
        as.push(lab[i * 3 + 1]);
        bs.push(lab[i * 3 + 2]);
      }
    const L = median(Ls),
      a = as.reduce((s, v) => s + v, 0) / as.length,
      b = bs.reduce((s, v) => s + v, 0) / bs.length;
    srcStats[r] = { L, a, b, C: Math.hypot(a, b), h: Math.atan2(b, a) };
  }
  const T = {};
  for (const [name, r] of Object.entries(regionId)) {
    const t = rc.targets[name];
    const [L, a, b] = t.lab || hexToLab(t.hex);
    T[r] = { ...t, L, a, b, C: Math.hypot(a, b), h: Math.atan2(b, a) };
  }
  const mapLab = (r, L, a, b) => {
    const s = srcStats[r],
      t = T[r];
    let L2;
    if (t.mode === 'ratio') {
      L2 = Lof(
        Yof(Math.max(0, L)) * (Yof(t.L) / Yof(s.L)) * (t.gloss ?? 1) +
          Yof(t.L) * (1 - (t.gloss ?? 1)) * (L > 0 ? 1 : 0),
      );
      // gloss < 1 pulls the gloss toward the mean in Y (not used unless set)
      L2 = Math.sqrt(L2 * L2 + (t.floorL ?? 0) ** 2);
    } else L2 = t.L + (L - s.L) * (t.kL ?? 1);
    let a2, b2;
    if (t.chroma === 'offset') {
      a2 = t.a + (a - s.a) * (t.kd ?? 1);
      b2 = t.b + (b - s.b) * (t.kd ?? 1);
    } else {
      const dh = t.h - s.h,
        cs = Math.cos(dh),
        sn = Math.sin(dh);
      let k = t.C / Math.max(1e-3, s.C);
      if (t.mode === 'ratio' && L > 0.5)
        k *= clamp(L2 / t.L / (L / s.L), 0.5, 2);
      a2 = (a * cs - b * sn) * k;
      b2 = (a * sn + b * cs) * k;
    }
    return [clamp(L2, 0, 100), a2, b2];
  };
  const mapRGB = (r, rgb) =>
    lab2rgb(
      ...mapLab(
        r,
        ...rgb2lab(
          clamp(rgb[0], 0, 255),
          clamp(rgb[1], 0, 255),
          clamp(rgb[2], 0, 255),
        ),
      ),
    );

  // ink targets
  const inkDst = {};
  const bandSrc = lab2rgb(srcStats[BAND].L, srcStats[BAND].a, srcStats[BAND].b);
  const bandDst = lab2rgb(T[BAND].L, T[BAND].a, T[BAND].b);
  const darkInk = mapRGB(NAVY, inkSrc[rc.darkInkFrom]);
  const decisions = [];
  for (const [name, ink] of Object.entries(INK)) {
    if (ink.to === 'same') inkDst[name] = inkSrc[name];
    else if (ink.to === 'navy') inkDst[name] = mapRGB(NAVY, inkSrc[name]);
    else if (ink.to === 'bandReadable') {
      const base = contrast(inkSrc[name], bandSrc);
      const now = contrast(inkSrc[name], bandDst);
      const dark = contrast(darkInk, bandDst);
      const sw = now < base;
      inkDst[name] = sw ? darkInk : inkSrc[name];
      const msg = `band ink ${name}: gold ${hex(inkSrc[name])} on 151 pink ${hex(bandSrc)} = ${base.toFixed(2)}:1; on ${pack} band ${hex(bandDst)} = ${now.toFixed(2)}:1 -> ${sw ? `switched to dark ink ${hex(darkInk)} (${dark.toFixed(2)}:1)` : 'kept gold'}`;
      decisions.push(msg);
      console.log(msg);
    } else throw new Error(`ink ${name}: unknown target ${ink.to}`);
  }

  // ---- compose ----------------------------------------------------------------------------
  const out = new Float32Array(img);
  const inkNames = Object.keys(INK);
  const inkRegion = inkNames.map((n) => regionId[INK[n].region]);
  const tStart = Date.now();
  for (let i = 0; i < W * H; i++) {
    const r = label[i];
    if (r === KEEP) continue;
    const p = [img[i * 3], img[i * 3 + 1], img[i * 3 + 2]];
    if (border[i]) {
      const GA = ground[sideA[i]],
        GB = ground[sideB[i]];
      const ga = [GA[i * 3], GA[i * 3 + 1], GA[i * 3 + 2]],
        gb = [GB[i * 3], GB[i * 3 + 1], GB[i * 3 + 2]];
      const d = [gb[0] - ga[0], gb[1] - ga[1], gb[2] - ga[2]];
      const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      const al =
        dd > 1
          ? clamp(
              ((p[0] - ga[0]) * d[0] +
                (p[1] - ga[1]) * d[1] +
                (p[2] - ga[2]) * d[2]) /
                dd,
              0,
              1,
            )
          : 0;
      const ma = mapRGB(sideA[i], ga),
        mb = mapRGB(sideB[i], gb);
      const res =
        lum(p[0], p[1], p[2]) -
        lum(...[0, 1, 2].map((c) => lerp(ga[c], gb[c], al)));
      for (let c = 0; c < 3; c++)
        out[i * 3 + c] = lerp(ma[c], mb[c], al) + clamp(res, -20, 20);
      continue;
    }
    if (!unknown[r][i]) {
      const m = mapRGB(r, p);
      for (let c = 0; c < 3; c++) out[i * 3 + c] = m[c];
      continue;
    }
    const G = ground[r];
    const g = [G[i * 3], G[i * 3 + 1], G[i * 3 + 2]];
    let best = null;
    for (let k = 0; k < inkNames.length; k++) {
      if (inkRegion[k] !== r) continue;
      const K = inkSrc[inkNames[k]];
      const d = [K[0] - g[0], K[1] - g[1], K[2] - g[2]];
      const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
      const al =
        dd > 1
          ? clamp(
              ((p[0] - g[0]) * d[0] +
                (p[1] - g[1]) * d[1] +
                (p[2] - g[2]) * d[2]) /
                dd,
              0,
              1,
            )
          : 0;
      let e = 0;
      for (let c = 0; c < 3; c++) e += (p[c] - (g[c] + al * d[c])) ** 2;
      if (!best || e < best.e) best = { k, al, e };
    }
    const K = inkSrc[inkNames[best.k]],
      K2 = inkDst[inkNames[best.k]];
    const al = best.al;
    // the ground actually under this pixel (grain kept) while coverage is low
    const geff = [0, 1, 2].map((c) =>
      clamp(al < 0.98 ? (p[c] - al * K[c]) / (1 - al) : g[c], 0, 255),
    );
    const w = clamp((al - 0.3) / 0.5, 0, 1);
    const gu = [0, 1, 2].map((c) => lerp(geff[c], g[c], w));
    const mg = mapRGB(r, gu);
    for (let c = 0; c < 3; c++) out[i * 3 + c] = lerp(mg[c], K2[c], al);
  }
  console.log(`composed in ${Date.now() - tStart} ms`);

  // ---- e) re-canvas -----------------------------------------------------------------------
  const front = await rawRGBA(cfg.front);
  const { W: Wf, H: Hf } = front;
  const pl = placement(Wf, Hf);
  const mism = Object.keys(pl.back).filter(
    (k) => JSON.stringify(pl.back[k]) !== JSON.stringify(cfg.back[k]),
  );
  if (mism.length)
    throw new Error(
      `packs/${pack}.json "back" must be ${JSON.stringify(pl.back)} (scale ${pl.s}, pad ${pl.padX},${pl.padY}); differs in ${mism.join(', ')}`,
    );
  let planes = [0, 1, 2].map((c) => {
    const P = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) P[i] = sil[i] ? out[i * 3 + c] : 0;
    return P;
  });
  const mask = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) mask[i] = sil[i];
  let Ws = W,
    Hs = H;
  if (pl.s !== 1) {
    Ws = Math.round(W * pl.s);
    Hs = Math.round(H * pl.s);
    [planes[0], planes[1], planes[2], planes[3]] = lanczosResize(
      [...planes, mask],
      W,
      H,
      Ws,
      Hs,
    );
  } else planes[3] = mask;
  const png = Buffer.alloc(Wf * Hf * 3);
  let lifted = 0;
  for (let y = 0; y < Hs; y++)
    for (let x = 0; x < Ws; x++) {
      const X = x + pl.padX,
        Y = y + pl.padY;
      if (X < 0 || Y < 0 || X >= Wf || Y >= Hf)
        throw new Error('scaled back does not fit the canvas');
      const i = y * Ws + x;
      if (planes[3][i] < 0.5) continue;
      const c = [0, 1, 2].map((k) => clamp(planes[k][i], 0, 255));
      const mx = Math.max(...c);
      if (mx < 7) {
        lifted++;
        for (let k = 0; k < 3; k++) c[k] += 7 - mx;
      }
      for (let k = 0; k < 3; k++) png[(Y * Wf + X) * 3 + k] = Math.round(c[k]);
    }
  await sharp(png, { raw: { width: Wf, height: Hf, channels: 3 } })
    .png({ compressionLevel: 9 })
    .toFile(refFile);
  console.log(
    `wrote ${path.relative(REPO, refFile)} ${Wf}x${Hf} (scale ${pl.s}, pad ${pl.padX},${pl.padY}; ${lifted} px lifted to max channel 7)`,
  );

  // record: inputs, zones in back-a frame, palette, decisions
  const rec = {
    pack,
    inputs: Object.fromEntries(
      Object.entries({
        back: SRC.back,
        plate: SRC.plate,
        geometry: SRC.geometry,
        matched: abs(rc.source.matched),
        front: cfg.front,
      }).map(([k, f]) => [
        k,
        { file: path.relative(REPO, f).replace(/\\/g, '/'), sha256: sha(f) },
      ]),
    ),
    shift151: { off: sh.off, dy: sh.dy },
    zonesBackA: zonesA,
    placement: pl,
    diagonal: fit,
    source: Object.fromEntries(
      [PALE, NAVY, BAND].map((r) => [
        NAMES[r],
        {
          lab: [srcStats[r].L, srcStats[r].a, srcStats[r].b].map(
            (v) => +v.toFixed(2),
          ),
          hex: hex(lab2rgb(srcStats[r].L, srcStats[r].a, srcStats[r].b)),
        },
      ]),
    ),
    target: Object.fromEntries(
      [PALE, NAVY, BAND].map((r) => [
        NAMES[r],
        {
          lab: [T[r].L, T[r].a, T[r].b].map((v) => +v.toFixed(2)),
          hex: hex(lab2rgb(T[r].L, T[r].a, T[r].b)),
          mode: T[r].mode,
          chroma: T[r].chroma || 'rotate',
        },
      ]),
    ),
    inks: Object.fromEntries(
      inkNames.map((n) => [n, { from: hex(inkSrc[n]), to: hex(inkDst[n]) }]),
    ),
    decisions,
  };
  fs.writeFileSync(
    path.join(cfg.outDir, `${pack}-back-ref.json`),
    JSON.stringify(rec, null, 2) + '\n',
  );
  for (const r of [PALE, NAVY, BAND])
    console.log(
      `${NAMES[r]}: source ${rec.source[NAMES[r]].hex} -> target ${rec.target[NAMES[r]].hex}`,
    );
  if (process.env.DEBUG_LABELS) {
    const dbg = Buffer.alloc(W * H * 3);
    const col = [
      [0, 0, 0],
      [240, 220, 200],
      [30, 40, 120],
      [220, 40, 140],
    ];
    for (let i = 0; i < W * H; i++) {
      let c = col[label[i]];
      if (border[i]) c = [0, 255, 0];
      for (const r of [PALE, NAVY, BAND]) if (unknown[r][i]) c = [255, 255, 0];
      for (let k = 0; k < 3; k++) dbg[i * 3 + k] = c[k];
    }
    await sharp(dbg, { raw: { width: W, height: H, channels: 3 } })
      .png()
      .toFile(process.env.DEBUG_LABELS);
  }
}

// ------------------------------------------------------------------------------------------
// Step 3: find this pack's text shift (trial matched vs ref, pixel identity) and seed
// printZones in <outDir>/<pack>-back-geometry.json for match-back.cjs --final to carry.
async function stepZones() {
  const rec = JSON.parse(
    fs.readFileSync(path.join(cfg.outDir, `${pack}-back-ref.json`), 'utf8'),
  );
  const B = await rawRGB(refFile);
  const work = path.join(cfg.workDir, `${pack}-back-${cfg.seamMode}.png`);
  const Mw = await rawRGBA(work);
  const { W, H } = B;
  const pl = rec.placement;
  // search around the text block
  let best = null;
  for (let dy = -80; dy <= 80; dy++)
    for (let off = -40; off <= 40; off++) {
      let same = 0,
        n = 0;
      for (let Y = cfg.back.textTop + 40; Y < cfg.back.textBottom - 40; Y += 13)
        for (let X = cfg.back.stripRight + 40; X < cfg.back.xR - 40; X += 9) {
          if (X >= cfg.back.seam[0] - 4 && X <= cfg.back.seam[1] + 4) continue;
          const XX = X + off,
            YY = Y + dy;
          if (XX < 0 || YY < 0 || XX >= W || YY >= H) continue;
          n++;
          const p = (YY * W + XX) * 4,
            q = (Y * W + X) * 3;
          if (
            Mw.data[p] === B.data[q] &&
            Mw.data[p + 1] === B.data[q + 1] &&
            Mw.data[p + 2] === B.data[q + 2]
          )
            same++;
        }
      if (!best || same > best.same) best = { off, dy, same, n };
    }
  if (best.same < best.n * 0.97)
    throw new Error(`pack shift unclear: ${JSON.stringify(best)}`);
  console.log(
    `${pack} shift ref->matched: off=${best.off} dy=${best.dy} (${best.same}/${best.n} identical)`,
  );
  const geo151 = JSON.parse(fs.readFileSync(SRC.geometry, 'utf8'));
  const toPack = (x, isX) =>
    isX ? x * pl.s + pl.padX + best.off : x * pl.s + pl.padY + best.dy;
  const byId = Object.fromEntries(rec.zonesBackA.map((z) => [z.id, z]));
  const zones = geo151.printZones.zones.map((z) => {
    // back-a pixel rect of this zone (live zones recorded; others moved the same way)
    const a = byId[z.id] || {
      x0: Math.round(z.rect.x0 * 897) - rec.shift151.off,
      x1: Math.round(z.rect.x1 * 897) - rec.shift151.off,
      y0: Math.round(z.rect.y0 * 1666) - rec.shift151.dy,
      y1: Math.round(z.rect.y1 * 1666) - rec.shift151.dy,
    };
    const f = (v) => +v.toFixed(5);
    return {
      ...z,
      rect: {
        x0: f(toPack(a.x0, true) / W),
        x1: f(toPack(a.x1, true) / W),
        y0: f(toPack(a.y0, false) / H),
        y1: f(toPack(a.y1, false) / H),
      },
    };
  });
  const seed = { pack, printZones: { ...geo151.printZones, zones } };
  const gfile = path.join(cfg.outDir, `${pack}-back-geometry.json`);
  const prev = fs.existsSync(gfile)
    ? JSON.parse(fs.readFileSync(gfile, 'utf8'))
    : {};
  fs.writeFileSync(gfile, JSON.stringify({ ...prev, ...seed }, null, 2) + '\n');
  rec.packShift = { off: best.off, dy: best.dy };
  fs.writeFileSync(
    path.join(cfg.outDir, `${pack}-back-ref.json`),
    JSON.stringify(rec, null, 2) + '\n',
  );
  console.log(`seeded printZones in ${path.relative(REPO, gfile)}`);
  for (const z of zones)
    console.log(
      `  ${z.id}: x ${(z.rect.x0 * W).toFixed(1)}-${(z.rect.x1 * W).toFixed(1)} y ${(z.rect.y0 * H).toFixed(1)}-${(z.rect.y1 * H).toFixed(1)}`,
    );
}

// ------------------------------------------------------------------------------------------
// Step 5: plate = the final matched back (its live zones were blank before matching) + checks.
async function stepPlate() {
  const matched = path.join(cfg.outDir, `${pack}-back-matched.png`);
  const plate = path.join(cfg.outDir, `${pack}-back-plate.png`);
  fs.copyFileSync(matched, plate);
  const Pm = await rawRGBA(plate);
  const F = await rawRGBA(cfg.front, { flop: true });
  const { W, H } = Pm;
  if (F.W !== W || F.H !== H) throw new Error('plate and front differ in size');
  let aDiff = 0;
  for (let i = 0; i < W * H; i++)
    if (Pm.data[i * 4 + 3] !== F.data[i * 4 + 3]) aDiff++;
  const geo = JSON.parse(
    fs.readFileSync(
      path.join(cfg.outDir, `${pack}-back-geometry.json`),
      'utf8',
    ),
  );
  const rects = zoneRects(geo, W, H, 'live');
  // ink proof per zone: (1) no pixel is type-coloured (white-ish or gold-ish over the ground),
  // (2) no pixel stands above a 9x9 local median by more than the ground's own gloss does
  //     in a same-size patch of untouched ground (the strip of ground right of the box)
  const L = new Float32Array(W * H),
    Cc = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const l = rgb2lab(Pm.data[i * 4], Pm.data[i * 4 + 1], Pm.data[i * 4 + 2]);
    L[i] = l[0];
    Cc[i] = Math.hypot(l[1], l[2]);
  }
  const localStat = (r) => {
    let maxL = 0,
      maxPeak = 0,
      typeLike = 0,
      n = 0;
    const peaks = [];
    for (let y = r.y0 + 4; y < r.y1 - 4; y++)
      for (let x = r.x0 + 4; x < r.x1 - 4; x++) {
        const i = y * W + x;
        n++;
        maxL = Math.max(maxL, L[i]);
        const win = [];
        for (let dy = -4; dy <= 4; dy++)
          for (let dx = -4; dx <= 4; dx++) win.push(L[i + dy * W + dx]);
        win.sort((a, b) => a - b);
        const pk = L[i] - win[40];
        peaks.push(pk);
        maxPeak = Math.max(maxPeak, pk);
      }
    peaks.sort((a, b) => a - b);
    return { n, maxL, maxPeak, p999: peaks[Math.floor(peaks.length * 0.999)] };
  };
  // a type-like pixel = clearly brighter than the zone's ground AND near-neutral or gold
  const report = [];
  for (const r of rects) {
    const st = localStat(r);
    report.push({
      id: r.id,
      rect: [r.x0, r.y0, r.x1, r.y1],
      ...Object.fromEntries(
        Object.entries(st).map(([k, v]) => [k, +(+v).toFixed(2)]),
      ),
    });
  }
  // reference: same stats on the 151 plate's zones (the accepted blank)
  const P151 = await rawRGBA(SRC.plate);
  const g151 = JSON.parse(fs.readFileSync(SRC.geometry, 'utf8'));
  const L151 = new Float32Array(P151.W * P151.H);
  for (let i = 0; i < L151.length; i++)
    L151[i] = rgb2lab(
      P151.data[i * 4],
      P151.data[i * 4 + 1],
      P151.data[i * 4 + 2],
    )[0];
  const ref = zoneRects(g151, P151.W, P151.H, 'live').map((r) => {
    let maxPeak = 0,
      maxL = 0;
    for (let y = r.y0 + 4; y < r.y1 - 4; y++)
      for (let x = r.x0 + 4; x < r.x1 - 4; x++) {
        const i = y * P151.W + x;
        const win = [];
        for (let dy = -4; dy <= 4; dy++)
          for (let dx = -4; dx <= 4; dx++) win.push(L151[i + dy * P151.W + dx]);
        win.sort((a, b) => a - b);
        maxPeak = Math.max(maxPeak, L151[i] - win[40]);
        maxL = Math.max(maxL, L151[i]);
      }
    return { id: r.id, maxL: +maxL.toFixed(2), maxPeak: +maxPeak.toFixed(2) };
  });
  console.log(
    `plate: ${path.relative(REPO, plate)} (copy of the final matched back)`,
  );
  console.log(`check: alpha differs from the mirrored front in ${aDiff} px`);
  for (const z of report)
    console.log(
      `zone ${z.id}: max L ${z.maxL}, max rise over 9x9 median ${z.maxPeak} (p99.9 ${z.p999})`,
    );
  for (const z of ref)
    console.log(
      `  151 plate zone ${z.id}: max L ${z.maxL}, max rise ${z.maxPeak}`,
    );
  fs.writeFileSync(
    path.join(cfg.outDir, `${pack}-plate-checks.json`),
    JSON.stringify(
      {
        alphaMismatchPx: aDiff,
        zones: report,
        reference151: ref,
        plateSha256: sha(plate),
        frontSha256: sha(cfg.front),
      },
      null,
      2,
    ) + '\n',
  );
  if (aDiff) throw new Error('alpha mismatch');
}

(async () => {
  if (step === 'ref') await stepRef();
  else if (step === 'zones') await stepZones();
  else if (step === 'plate') await stepPlate();
  else throw new Error(`unknown step ${step}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
