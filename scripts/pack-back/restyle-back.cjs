/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS node tool */
// Restyle the approved 151 back into another pack family and fit it to that pack's front.
//
//   node scripts/pack-back/restyle-back.cjs <pack> [--debug]
//
// Writes <outDir>/<pack>-back-plate.png and <pack>-back-geometry.json. The live-text zones
// (the reference geometry's printZones with plate "live") are blank on the plate.
//
// The 151 back is read as layers, never recoloured pixel by pixel:
//   film   the sleeve (151: navy foil and the rainbow edge strip)
//   panel  the pale logo panel (coverage aP), band  the pink band (coverage aK)
//   inks   five inks, each with its own coverage: logo ink on the panel, gold and white ink
//          on the band, white text and the gold odds outline on the film
// Coverages come from unmixing each pixel between its paper and its ink (and, along the panel
// and band edges, between the two papers), so the antialiasing of every glyph is kept. The
// live-text zones get ink coverage 0 BEFORE anything else happens, so no 151 price, product
// line, odds or buyback text reaches any output.
// The layers are fitted to the target front with the same warp as match-back.cjs (text rows and
// columns move by whole pixels, never resampled), then composited over a film synthesised in
// the target's own frame from robust statistics of the mirrored front: its level, the sheen
// profile toward each edge and each crimp, its chroma per lightness and its grain. The front's
// own crimps, a fin seal made of its crimp foil and its outer rim finish the sleeve, as in
// match-back.cjs. Alpha is the mirrored front's, byte for byte.
const fs = require('fs');
const path = require('path');
const {
  sharp,
  loadConfig,
  loadGeometry,
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
if (!pack) throw new Error('usage: node restyle-back.cjs <pack> [--debug]');
const DEBUG = args.includes('--debug');
// --variant=<name>: the config's variants[name].palette over the default palette; writes only
// <pack>-back-plate-<name>.png (the default plate and the geometry are left alone)
const VARIANT =
  (args.find((a) => a.startsWith('--variant=')) || '').slice(10) || null;
const cfg = loadConfig(pack);
const ref = loadConfig(cfg.ref || '151');
const refGeo = loadGeometry(ref);
if (!refGeo?.printZones || !refGeo?.printArea)
  throw new Error(`reference ${ref.name} has no geometry with printZones`);
fs.mkdirSync(cfg.workDir, { recursive: true });
fs.mkdirSync(cfg.outDir, { recursive: true });

// ---- the reference design (151-back-a.png), measured once --------------------------------
// Paper and ink colours (sRGB) and edge columns. Panel and band are flat prints; the navy foil
// varies, so its paper colour is estimated locally.
const REF = {
  panel: [247, 231, 231],
  panelInk: [22, 23, 71], // the logo
  bandGold: [222, 185, 114], // "1 CARD PER PACK", the 18+ roundel
  bandWhite: [254, 253, 254], // "WWW.POLYCARDS.GG"
  navyWhite: [237, 237, 242], // "Open packs...", "Pull odds (by rarity)" (and the live text)
  navyGold: [200, 168, 102], // the odds box outline
  stripEdge: 73, // first column past the unprinted edge strip (partly covered)
  bandX0: 347, // first and last columns of the panel/band edge (both partly covered)
  bandX1: 348,
  bandRight: 443, // last band column (the fin seal follows)
  diagFit: [
    [78, 170],
    [250, 344],
  ], // columns used to fit the panel's diagonal edge (clear of the logo)
  oddsBoxX0: 577, // left edge of the odds box outline
  // where ink sits on the film: the headline block and the odds box (with its heading and
  // the live text). Elsewhere a bright gloss on the navy is never ink.
  filmInkBoxes: [
    { x0: 108, x1: 312, y0: 628, y1: 1456 },
    { x0: 570, x1: 849, y0: 822, y1: 1452 },
    { x0: 600, x1: 840, y0: 220, y1: 800 }, // the buyback paragraph (live, blanked)
  ],
};
// Family recipe: the same for every pack of the family; only the palette is per pack.
const RECIPE = {
  sideReach: 180, // px: edge sheen profile length
  crimpReach: 300, // px: shoulder sheen profile length
  skip: 200, // px kept clear of the crimps / edges when taking the other profile
  despike: 5, // px: median window that drops printed rules from the sheen profiles
  soften: 3, // px: then a short mean
  foilShare: 0.15, // share of the 151 foil's own soft sheen kept in the film (L*)
  printSheen: 0.35, // share of the film's sheen (linear light) that also shows on the prints
  crackle: 0.45, // share of crackle lines in the synthetic grain (the rest is fine noise)
  printGrain: 0.6, // L*: fine grain on the panel and band (no crackle: they are prints)
  inkMin: 0.35, // ink coverage that seeds an ink mask (dilated by inkGrow)
  inkGrow: 2,
  crackCell: 20, // px: cell size of the crackle in the synthetic grain
  grainMax: 2, // L*: cap on the film grain (faceted or textured front art reads as grain)
  printContrast: 7.5, // pale ink against the film, at least, inside the print area
  printFade: 28, // px: the print-area hold fades out over this distance outside it
  seed: 7,
};
const INKS = ['panelInk', 'bandInk', 'bandInk', 'text', 'outline']; // palette key per ink layer
const INK_NAMES = [
  'panel logo',
  'band gold',
  'band white',
  'film white',
  'odds outline',
];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const hex = (h) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(h);
  if (!m) throw new Error(`bad colour ${h}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toLin = (c) => {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};
const fromLin = (v) =>
  255 *
  (v <= 0.0031308
    ? 12.92 * v
    : 1.055 * Math.pow(Math.max(0, v), 1 / 2.4) - 0.055);
const Yof = (L) => {
  const fy = (L + 16) / 116;
  return fy ** 3 > 0.008856 ? fy ** 3 : L / 903.3;
};
const LofY = (Y) => (Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y);

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

/** Box blur (running sums), 3 passes ~ gaussian; in place on a copy. */
function blur(src, W, H, r) {
  let a = Float32Array.from(src),
    b = new Float32Array(W * H);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < H; y++) {
      let s = 0;
      const o = y * W;
      for (let x = -r; x <= r; x++) s += a[o + clamp(x, 0, W - 1)];
      for (let x = 0; x < W; x++) {
        b[o + x] = s / (2 * r + 1);
        s += a[o + clamp(x + r + 1, 0, W - 1)] - a[o + clamp(x - r, 0, W - 1)];
      }
    }
    for (let x = 0; x < W; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += b[clamp(y, 0, H - 1) * W + x];
      for (let y = 0; y < H; y++) {
        a[y * W + x] = s / (2 * r + 1);
        s +=
          b[clamp(y + r + 1, 0, H - 1) * W + x] -
          b[clamp(y - r, 0, H - 1) * W + x];
      }
    }
  }
  return a;
}

/** Normalised convolution: smooth `val` where `w` > 0, filling the rest from ever wider rings. */
function fillSmooth(val, w, W, H, radii) {
  const out = new Float32Array(W * H).fill(NaN);
  for (const r of radii) {
    const vw = new Float32Array(W * H);
    for (let p = 0; p < W * H; p++) vw[p] = val[p] * w[p];
    const bv = blur(vw, W, H, r),
      bw = blur(w, W, H, r);
    for (let p = 0; p < W * H; p++)
      if (Number.isNaN(out[p]) && bw[p] > 0.05) out[p] = bv[p] / bw[p];
  }
  const all = [];
  for (let p = 0; p < W * H; p += 97)
    if (!Number.isNaN(out[p])) all.push(out[p]);
  const m = median(all) ?? 0;
  for (let p = 0; p < W * H; p++) if (Number.isNaN(out[p])) out[p] = m;
  return out;
}

const proj = (c, p, q) => {
  // coverage t of q over p that best explains c, and the residual
  const d0 = q[0] - p[0],
    d1 = q[1] - p[1],
    d2 = q[2] - p[2];
  const n = d0 * d0 + d1 * d1 + d2 * d2 || 1;
  const t = ((c[0] - p[0]) * d0 + (c[1] - p[1]) * d1 + (c[2] - p[2]) * d2) / n;
  const tc = clamp(t, 0, 1);
  const r = Math.hypot(
    c[0] - p[0] - tc * d0,
    c[1] - p[1] - tc * d1,
    c[2] - p[2] - tc * d2,
  );
  return [tc, r];
};

(async () => {
  const pal = {};
  for (const k of ['panel', 'panelInk', 'band', 'bandInk', 'text', 'outline'])
    pal[k] = hex(
      (VARIANT && cfg.variants?.[VARIANT]?.palette?.[k]) || cfg.palette[k],
    );
  if (VARIANT && !cfg.variants?.[VARIANT])
    throw new Error(`no variant "${VARIANT}" in ${cfg.name}.json`);

  // ---- load: mirrored front, the reference padded with black to the front's width ---------
  const F = await rawRGBA(cfg.front, { flop: true });
  const { W, H } = F;
  const Fd = F.data;
  const B0 = await rawRGB(ref.backRef);
  if (B0.H !== H)
    throw new Error(`height mismatch front ${H} reference ${B0.H}`);
  if (B0.W > W)
    throw new Error(`reference wider (${B0.W}) than the front (${W})`);
  const W0 = B0.W;
  const Bd = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++)
    B0.data.copy(Bd, y * W * 3, y * W0 * 3, (y + 1) * W0 * 3);
  const bpx = (x, y) => {
    const p = (y * W + x) * 3;
    return [Bd[p], Bd[p + 1], Bd[p + 2]];
  };
  const bk = ref.back;
  console.log(
    `${cfg.name}: front ${W}x${H}; reference ${ref.name} ${W0}x${H} padded to ${W}`,
  );

  // ---- the reference's own shift (backRef -> its matched back), for its print zones -------
  const offR = Math.round(refGeo.printArea.x0 * W0) - bk.stripRight;
  const dyR = Math.round(refGeo.printArea.y0 * H) - bk.textTop;
  if (
    Math.round(refGeo.printArea.x1 * W0) !== bk.xR + offR ||
    Math.round(refGeo.printArea.y1 * H) !== bk.textBottom + dyR
  )
    throw new Error('reference printArea does not match its config');
  console.log(`reference shift: off=${offR}, dy=${dyR}`);
  const zonesRef = refGeo.printZones.zones.map((z) => ({
    ...z,
    px: {
      x0: Math.round(z.rect.x0 * W0) - offR,
      x1: Math.round(z.rect.x1 * W0) - offR,
      y0: Math.round(z.rect.y0 * H) - dyR,
      y1: Math.round(z.rect.y1 * H) - dyR,
    },
  }));
  const liveRef = zonesRef
    .filter((z) => !z.plate || z.plate === 'live')
    .map((z) => z.px);
  const inRect = (rs, x, y) =>
    rs.some((r) => x >= r.x0 && x < r.x1 && y >= r.y0 && y < r.y1);

  // ---- 1. layers of the reference -------------------------------------------------------
  const N = W * H;
  const aP = new Float32Array(N),
    aK = new Float32Array(N);
  const aI = Array.from({ length: 5 }, () => new Float32Array(N));
  const Lab = new Float32Array(N * 3);
  for (let p = 0; p < N; p++) {
    const l = rgb2lab(Bd[p * 3], Bd[p * 3 + 1], Bd[p * 3 + 2]);
    Lab[p * 3] = l[0];
    Lab[p * 3 + 1] = l[1];
    Lab[p * 3 + 2] = l[2];
  }
  // the panel's diagonal lower edge: sub-pixel crossing per column, straight-line fit
  const Lp = rgb2lab(...REF.panel)[0];
  const pts = [];
  for (const [c0, c1] of REF.diagFit)
    for (let x = c0; x <= c1; x++)
      for (let y = 500; y < 720; y++) {
        const a = Lab[(y * W + x) * 3],
          b = Lab[((y + 1) * W + x) * 3];
        const mid = (Lp + 12) / 2;
        if (a >= mid && b < mid) {
          pts.push([x, y + 0.5 + (a - mid) / (a - b)]);
          break;
        }
      }
  const mx = pts.reduce((s, v) => s + v[0], 0) / pts.length,
    my = pts.reduce((s, v) => s + v[1], 0) / pts.length;
  const slope =
    pts.reduce((s, v) => s + (v[0] - mx) * (v[1] - my), 0) /
    pts.reduce((s, v) => s + (v[0] - mx) ** 2, 0);
  const diag = (x) => my + slope * (x - mx); // edge position (pixel-centre rows)
  const diagErr = Math.max(...pts.map(([x, y]) => Math.abs(y - diag(x))));
  console.log(
    `panel diagonal: y = ${my.toFixed(2)} + ${slope.toFixed(4)}(x - ${mx.toFixed(1)}), ${pts.length} columns, worst ${diagErr.toFixed(2)} px`,
  );

  // paper coverages (geometry, with the edge pixels unmixed between their two papers)
  const T0 = bk.textTop,
    T1 = bk.textBottom;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W0; x++) {
      const p = y * W + x;
      const c = bpx(x, y);
      const yd = diag(x);
      const inPanelCols = x >= REF.stripEdge && x < REF.bandX0;
      // panel
      if (inPanelCols || x === REF.bandX0 || x === REF.bandX1) {
        if (y < yd - 3) aP[p] = 1;
        else if (y <= yd + 3) {
          const below = bpx(x, Math.min(H - 1, Math.ceil(yd) + 5));
          aP[p] = proj(c, below, REF.panel)[0];
        }
      }
      if (x === REF.stripEdge && aP[p] > 0) {
        // the strip edge: panel over the (unprinted) strip
        aP[p] *= proj(c, bpx(x - 2, y), bpx(x + 2, y))[0];
      }
      // band
      if (x > REF.bandX1 && x <= REF.bandRight) aK[p] = 1;
      else if (x === REF.bandX0 || x === REF.bandX1) {
        aK[p] = proj(c, bpx(REF.bandX0 - 2, y), bpx(REF.bandX1 + 2, y))[0];
      }
    }
  }
  // band paper: the pink varies (it brightens toward the fin and carries gloss streaks), so it
  // is smoothed locally from band pixels clear of the gold and white ink
  const bandInkC = new Uint8Array(N);
  for (let y = 0; y < H; y++)
    for (let x = REF.bandX1 + 1; x <= REF.bandRight; x++) {
      const p = y * W + x;
      const L = Lab[p * 3],
        C = Math.hypot(Lab[p * 3 + 1], Lab[p * 3 + 2]);
      if (Lab[p * 3 + 2] > 15 || (L > 75 && C < 35)) bandInkC[p] = 1;
    }
  const bandW = new Float32Array(N),
    bandV = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  for (let y = 2; y < H - 2; y++)
    for (let x = REF.bandX1 + 2; x <= REF.bandRight - 2; x++) {
      const p = y * W + x;
      let ink = false;
      for (let dy = -2; dy <= 2 && !ink; dy++)
        for (let dx = -2; dx <= 2; dx++)
          if (bandInkC[p + dy * W + dx]) ink = true;
      if (ink) continue;
      bandW[p] = 1;
      for (let k = 0; k < 3; k++) bandV[k][p] = Bd[p * 3 + k];
    }
  const bandPaper = bandV.map((v) => fillSmooth(v, bandW, W, H, [3, 8, 24]));
  // navy paper: smoothed foil with the ink left out
  const navyW = new Float32Array(N),
    navyV = [new Float32Array(N), new Float32Array(N), new Float32Array(N)];
  const candidate = new Uint8Array(N);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W0; x++) {
      const p = y * W + x;
      const L = Lab[p * 3],
        b = Lab[p * 3 + 2];
      if (L > 50 || (b > 15 && L > 30)) candidate[p] = 1;
    }
  for (let y = 2; y < H - 2; y++)
    for (let x = REF.stripEdge + 2; x < W0 - 2; x++) {
      const p = y * W + x;
      if (
        aP[p] > 0 ||
        aK[p] > 0 ||
        (x > REF.bandRight - 0 && x < bk.seam[1] + 2)
      )
        continue;
      let ink = false;
      for (let dy = -2; dy <= 2 && !ink; dy++)
        for (let dx = -2; dx <= 2; dx++)
          if (candidate[p + dy * W + dx]) ink = true;
      if (ink) continue;
      navyW[p] = 1;
      for (let k = 0; k < 3; k++) navyV[k][p] = Bd[p * 3 + k];
    }
  const navy = navyV.map((v) => fillSmooth(v, navyW, W, H, [6, 18, 60]));

  // inks: unmix each pixel against its local paper, keep the best-explaining ink
  const raw = Array.from({ length: 5 }, () => new Float32Array(N));
  for (let y = T0 - 4; y <= T1 + 4; y++)
    for (let x = REF.stripEdge + 1; x <= bk.xR; x++) {
      const p = y * W + x;
      if (x > REF.bandRight && x < bk.seam[1]) continue; // fin seal (replaced later)
      const c = bpx(x, y);
      if (aP[p] >= 0.999 && aK[p] === 0) {
        raw[0][p] = proj(c, REF.panel, REF.panelInk)[0];
      } else if (aK[p] >= 0.999 && x > REF.bandX1 && x < REF.bandRight) {
        const K = [bandPaper[0][p], bandPaper[1][p], bandPaper[2][p]];
        const g = proj(c, K, REF.bandGold),
          w = proj(c, K, REF.bandWhite);
        if (g[1] <= w[1]) raw[1][p] = g[0];
        else raw[2][p] = w[0];
      } else if (aP[p] === 0 && aK[p] === 0 && inRect(REF.filmInkBoxes, x, y)) {
        const n = [navy[0][p], navy[1][p], navy[2][p]];
        const w = proj(c, n, REF.navyWhite),
          g = proj(c, n, REF.navyGold);
        if (w[1] <= g[1]) raw[3][p] = w[0];
        else raw[4][p] = g[0];
      }
    }
  // ink masks: seeds above inkMin, grown by inkGrow; coverage outside the mask is foil noise
  for (let k = 0; k < 5; k++) {
    const seed = new Uint8Array(N);
    for (let p = 0; p < N; p++) if (raw[k][p] > RECIPE.inkMin) seed[p] = 1;
    const g = RECIPE.inkGrow;
    for (let y = g; y < H - g; y++)
      for (let x = g; x < W - g; x++) {
        const p = y * W + x;
        let near = false;
        for (let dy = -g; dy <= g && !near; dy++)
          for (let dx = -g; dx <= g; dx++)
            if (seed[p + dy * W + dx]) {
              near = true;
              break;
            }
        if (near) aI[k][p] = raw[k][p];
      }
  }

  // ---- 2. blank the live-text zones: no ink there, before anything else -------------------
  let blanked = 0;
  for (const r of liveRef)
    for (let y = r.y0; y < r.y1; y++)
      for (let x = r.x0; x < r.x1; x++)
        for (let k = 0; k < 5; k++) {
          const p = y * W + x;
          if (aI[k][p] > 0) blanked++;
          aI[k][p] = 0;
        }
  console.log(
    `live zones blanked in the reference: ${liveRef.length} rects, ${blanked} ink px removed`,
  );
  const inkCountRef = aI.map((a) => {
    let n = 0;
    for (let p = 0; p < N; p++) if (a[p] > 0.5) n++;
    return n;
  });
  console.log(
    'ink px (coverage > 0.5): ' +
      INK_NAMES.map((n, k) => `${n} ${inkCountRef[k]}`).join(', '),
  );

  // the 151 foil's own soft sheen (L*, zero-mean), kept as a small share of the film
  const navyL = new Float32Array(N);
  for (let p = 0; p < N; p++)
    navyL[p] = rgb2lab(
      clamp(navy[0][p], 0, 255),
      clamp(navy[1][p], 0, 255),
      clamp(navy[2][p], 0, 255),
    )[0];
  const navyMed = median(
    Array.from(navyL.filter((_, p) => navyW[p] > 0 && p % 13 === 0)),
  );
  const foilVar = new Float32Array(N);
  for (let p = 0; p < N; p++) foilVar[p] = navyL[p] - navyMed;

  // ---- 3. fit to the front (same maps as match-back.cjs) ----------------------------------
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
  const bT = bk.bodyTop,
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
    `fit: text rows shift dy=${dy}, columns off=${off} (whole pixels); top band x${sT.toFixed(3)}, bottom band x${sB.toFixed(3)}`,
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
  const chans = [aP, aK, ...aI, foilVar];
  const NC = chans.length;
  const warped = Array.from({ length: NC }, () => new Float32Array(N));
  let black = 0;
  const yA = Math.max(y0, Ct - 14),
    yZ = Math.min(y1, Cb + 14);
  for (let Y = yA; Y <= yZ; Y++) {
    if (mL[Y] == null) continue;
    const ya = clamp(vmap(Y), 0, H - 1);
    for (let X = 0; X < W; X++) {
      const P = Y * W + X;
      if (Fd[P * 4 + 3] === 0) continue;
      const xa = clamp(hmap(X, Y, ya), 0, W - 1);
      const x0 = Math.floor(xa),
        yy0 = Math.floor(ya),
        x1 = Math.min(W - 1, x0 + 1),
        yy1 = Math.min(H - 1, yy0 + 1);
      const tx = xa - x0,
        ty = ya - yy0;
      const w00 = (1 - tx) * (1 - ty),
        w10 = tx * (1 - ty),
        w01 = (1 - tx) * ty,
        w11 = tx * ty;
      const q00 = yy0 * W + x0,
        q10 = yy0 * W + x1,
        q01 = yy1 * W + x0,
        q11 = yy1 * W + x1;
      for (let k = 0; k < NC; k++) {
        const c = chans[k];
        warped[k][P] =
          c[q00] * w00 + c[q10] * w10 + c[q01] * w01 + c[q11] * w11;
      }
      if (Y >= Ct && Y <= Cb && Fd[P * 4 + 3] >= 128) {
        let m = 0;
        for (const [q, w] of [
          [q00, w00],
          [q10, w10],
          [q01, w01],
          [q11, w11],
        ])
          m += w * Math.max(Bd[q * 3], Bd[q * 3 + 1], Bd[q * 3 + 2]);
        if (m < 6) black++;
      }
    }
  }
  if (black > 0)
    throw new Error(
      `coverage: ${black} reference-background px inside the outline`,
    );
  const [wP, wK, ...wRest] = warped;
  const wI = wRest.slice(0, 5),
    wVar = wRest[5];

  // ---- 4. the film, measured from the mirrored front --------------------------------------
  const fL = new Float32Array(N),
    fA = new Float32Array(N),
    fB = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    const l = rgb2lab(Fd[p * 4], Fd[p * 4 + 1], Fd[p * 4 + 2]);
    fL[p] = l[0];
    fA[p] = l[1];
    fB[p] = l[2];
  }
  const DS = RECIPE.sideReach,
    DC = RECIPE.crimpReach,
    SK = RECIPE.skip;
  const sideProf = (side) => {
    const out = [];
    for (let d = 0; d <= DS; d++) {
      const v = [];
      for (let Y = Ct + SK; Y <= Cb - SK; Y += 2) {
        const X =
          side < 0 ? Math.round(ext.L[Y] + d) : Math.round(ext.R[Y] - d);
        v.push(fL[Y * W + X]);
      }
      out.push(median(v));
    }
    return smooth(smooth(out, RECIPE.despike, 'median'), RECIPE.soften);
  };
  const pLeft = sideProf(-1),
    pRight = sideProf(1);
  // shoulder sheen (and any shading toward the crimps): the median of each row across the
  // middle, for crimpReach rows from each crimp; single printed rules are despiked
  const crimpProf = (side) => {
    const out = [];
    for (let t = 0; t <= DC; t++) {
      const Y = side < 0 ? Ct + t : Cb - t;
      const v = [];
      for (let X = Math.ceil(ext.L[Y] + DS); X <= ext.R[Y] - DS; X += 2)
        v.push(fL[Y * W + X]);
      out.push(median(v));
    }
    return smooth(smooth(out, RECIPE.despike, 'median'), RECIPE.soften);
  };
  const pTop = crimpProf(-1),
    pBot = crimpProf(1);
  const plateau = (prof) => median(prof.slice(prof.length - 41));
  // the plain film's level: where every profile has run out of sheen
  const L0 = median([
    ...pLeft.slice(DS - 40),
    ...pRight.slice(DS - 40),
    ...pTop.slice(DC - 100),
    ...pBot.slice(DC - 100),
  ]);
  const Y0 = Yof(L0);
  console.log(
    `film: level L*${L0.toFixed(1)}; edge sheen peak L* left ${Math.max(...pLeft.slice(10)).toFixed(1)} right ${Math.max(...pRight.slice(10)).toFixed(1)}; toward the crimps L* top ${Math.min(...pTop.slice(10)).toFixed(1)}-${Math.max(...pTop).toFixed(1)} bottom ${Math.min(...pBot.slice(10)).toFixed(1)}-${Math.max(...pBot).toFixed(1)}`,
  );
  // the film's own pixels: the bands the sheen profiles were read from (edge bands past the
  // rim lines, shoulder bands across the middle), where the front carries little art
  const filmPx = [];
  for (let Y = Ct + SK; Y <= Cb - SK; Y += 2)
    for (let d = 20; d <= DS; d += 2) {
      filmPx.push(Y * W + Math.round(ext.L[Y] + d));
      filmPx.push(Y * W + Math.round(ext.R[Y] - d));
    }
  for (let t = 10; t <= DC; t += 2)
    for (const Y of [Ct + t, Cb - t])
      for (let X = Math.ceil(ext.L[Y] + DS); X <= ext.R[Y] - DS; X += 2)
        filmPx.push(Y * W + X);
  // chroma of the film per lightness (median a*, b* in 2.5 L* bins)
  const bins = [];
  for (const p of filmPx) {
    const b = Math.min(39, Math.floor(fL[p] / 2.5));
    (bins[b] ||= [[], []])[0].push(fA[p]);
    bins[b][1].push(fB[p]);
  }
  const chromaBin = [];
  for (let b = 0; b < 40; b++)
    chromaBin[b] =
      bins[b] && bins[b][0].length > 200
        ? [median(bins[b][0]), median(bins[b][1])]
        : null;
  for (let b = 1; b < 40; b++)
    if (!chromaBin[b]) chromaBin[b] = chromaBin[b - 1];
  for (let b = 38; b >= 0; b--)
    if (!chromaBin[b]) chromaBin[b] = chromaBin[b + 1];
  const chromaSm = chromaBin.map((_, b) => {
    let a = 0,
      c = 0,
      n = 0;
    for (let k = -2; k <= 2; k++) {
      const v = chromaBin[clamp(b + k, 0, 39)];
      a += v[0];
      c += v[1];
      n++;
    }
    return [a / n, c / n];
  });
  const chromaAt = (L) => {
    const f = clamp(L / 2.5 - 0.5, 0, 38.999),
      i = Math.floor(f),
      t = f - i;
    return [
      lerp(chromaSm[i][0], chromaSm[i + 1][0], t),
      lerp(chromaSm[i][1], chromaSm[i + 1][1], t),
    ];
  };
  // grain of the front per lightness: RMS of L* minus its 3x3 mean over the film's pixels,
  // with outliers (art edges) clipped at 4 robust deviations
  const gbins = [];
  for (const p of filmPx) {
    let s = 0;
    for (let dy2 = -1; dy2 <= 1; dy2++)
      for (let dx = -1; dx <= 1; dx++) s += fL[p + dy2 * W + dx];
    const b = Math.min(19, Math.floor(fL[p] / 5));
    (gbins[b] ||= []).push(fL[p] - s / 9);
  }
  const grainBin = [];
  for (let b = 0; b < 20; b++) {
    const v = gbins[b];
    if (!v || v.length < 200) {
      grainBin[b] = null;
      continue;
    }
    const m = median(v);
    const lim = 4 * 1.4826 * median(v.map((x) => Math.abs(x - m))) + 1e-6;
    grainBin[b] = Math.sqrt(
      v.reduce((s, x) => s + clamp(x - m, -lim, lim) ** 2, 0) / v.length,
    );
  }
  for (let b = 1; b < 20; b++)
    if (grainBin[b] == null) grainBin[b] = grainBin[b - 1];
  for (let b = 18; b >= 0; b--)
    if (grainBin[b] == null) grainBin[b] = grainBin[b + 1];
  const grainAt = (L) => {
    const f = clamp(L / 5 - 0.5, 0, 18.999),
      i = Math.floor(f);
    return Math.min(RECIPE.grainMax, lerp(grainBin[i], grainBin[i + 1], f - i));
  };
  console.log(
    `film grain (L* spread of the 3x3 high-pass) at L* 2.5/12.5/27.5/47.5: ${[2.5, 12.5, 27.5, 47.5].map((l) => grainAt(l).toFixed(2)).join(' / ')}`,
  );

  // synthetic grain: crackle (cell edges of a jittered grid) plus fine noise, unit high-pass
  const rand = prng(RECIPE.seed);
  const cs = RECIPE.crackCell,
    gx = Math.ceil(W / cs) + 6,
    gy = Math.ceil(H / cs) + 6;
  const jit = new Float32Array(gx * gy * 2);
  for (let i = 0; i < gx * gy * 2; i++) jit[i] = rand();
  const fine = new Float32Array(N);
  for (let p = 0; p < N; p++) {
    const u = Math.max(1e-9, rand()),
      v = rand();
    fine[p] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  // smooth random fields: a domain warp (so creases wander) and a mask (so only some show)
  const smoothNoise = (r) => {
    const n = new Float32Array(N);
    for (let p = 0; p < N; p++) n[p] = rand() - 0.5;
    const b = blur(n, W, H, r);
    let s2 = 0;
    for (let p = 0; p < N; p += 13) s2 += b[p] * b[p];
    const k = 1 / Math.sqrt(s2 / Math.ceil(N / 13));
    for (let p = 0; p < N; p++) b[p] *= k;
    return b;
  };
  const warpX = smoothNoise(5),
    warpY = smoothNoise(5),
    creaseMask = smoothNoise(10);
  const grain = new Float32Array(N);
  for (let Y = 0; Y < H; Y++)
    for (let X0 = 0; X0 < W; X0++) {
      const P = Y * W + X0;
      const X = X0 + 2.5 * warpX[P],
        Yw = Y + 2.5 * warpY[P];
      const cx = Math.floor(X / cs),
        cy = Math.floor(Yw / cs);
      let f1 = 1e9,
        f2 = 1e9;
      for (let j = -1; j <= 1; j++)
        for (let i = -1; i <= 1; i++) {
          const ix = cx + i + 3,
            iy = cy + j + 3;
          const k = (iy * gx + ix) * 2;
          const px = (cx + i + jit[k]) * cs,
            py = (cy + j + jit[k + 1]) * cs;
          const d = Math.hypot(X - px, Yw - py);
          if (d < f1) {
            f2 = f1;
            f1 = d;
          } else if (d < f2) f2 = d;
        }
      const e = (f2 - f1) / 0.8;
      const m = clamp((creaseMask[P] + 0.2) / 0.9, 0, 1);
      grain[P] = Math.exp(-e * e) * m * m * (3 - 2 * m); // thin bright creases, some of them
    }
  // each part scaled to unit RMS of its 3x3 high-pass, mixed, and the mix scaled the same way
  const unitHP = (g) => {
    let s2 = 0,
      n = 0,
      mean = 0;
    for (let p = 0; p < N; p += 11) mean += g[p];
    mean /= Math.ceil(N / 11);
    for (let p = W + 1; p < N - W - 1; p += 7) {
      let s = 0;
      for (let dy2 = -1; dy2 <= 1; dy2++)
        for (let dx = -1; dx <= 1; dx++) s += g[p + dy2 * W + dx];
      s2 += (g[p] - s / 9) ** 2;
      n++;
    }
    const k = 1 / Math.sqrt(s2 / n);
    for (let p = 0; p < N; p++) g[p] = (g[p] - mean) * k;
  };
  const fineS = blur(fine, W, H, 1);
  for (let p = 0; p < N; p++) fine[p] -= fineS[p];
  unitHP(grain);
  unitHP(fine);
  for (let p = 0; p < N; p++)
    grain[p] = RECIPE.crackle * grain[p] + (1 - RECIPE.crackle) * fine[p];
  unitHP(grain);

  // film lightness in the target frame
  // each profile over the film's level, eased out over the last 40% of its reach (a long ease,
  // so a broad shading toward a crimp fades into the film instead of ending on a line)
  const exc = (prof, d, reach) => {
    if (d < 0) d = 0;
    if (d >= reach) return 0;
    const i = Math.floor(d),
      v = lerp(prof[i], prof[Math.min(reach, i + 1)], d - i);
    const e0 = reach * 0.6;
    const taper = d > e0 ? 1 - (d - e0) / (reach - e0) : 1;
    return (Yof(v) - Y0) * taper * taper * (3 - 2 * taper);
  };
  const filmL = new Float32Array(N);
  const sheenY = new Float32Array(N); // the film's sheen in linear light, for the prints
  for (let Y = y0; Y <= y1; Y++) {
    if (ext.L[Y] == null) continue;
    const c = Y - Ct < Cb - Y ? exc(pTop, Y - Ct, DC) : exc(pBot, Cb - Y, DC);
    for (let X = 0; X < W; X++) {
      const P = Y * W + X;
      if (Fd[P * 4 + 3] === 0) continue;
      const dl = X - ext.L[Y],
        dr = ext.R[Y] - X;
      const s = dl < dr ? exc(pLeft, dl, DS) : exc(pRight, dr, DS);
      // where an edge highlight meets a shoulder highlight they merge round, not in a mitre
      const e = s > 0 && c > 0 ? Math.cbrt(s ** 3 + c ** 3) : s + c;
      const L = LofY(Math.max(0, Y0 + e)) + RECIPE.foilShare * wVar[P];
      filmL[P] = clamp(L, 0, 100);
    }
  }
  // Optional (config "filmMatch"): a front whose body is a mid-tone film darker than its sheen
  // bands (Platinum's gunmetal) gets the film's level lowered to the front body's own tone:
  // the level moves to the front body's `levelPct` percentile; below the level the film scales
  // with it (linear light), above it the sheen keeps its own height. Smooth and monotone, so
  // nothing posterises.
  let Ysheen0 = Y0;
  if (cfg.filmMatch) {
    const fm = cfg.filmMatch;
    const ref = [];
    for (let Y = Ct; Y <= Cb; Y += 2)
      for (let X = Math.ceil(ext.L[Y]) + 2; X <= ext.R[Y] - 2; X += 2)
        ref.push(fL[Y * W + X]);
    ref.sort((a, b) => a - b);
    const Lt = ref[Math.floor(fm.levelPct * (ref.length - 1))];
    const Yt = Yof(Lt);
    const mapY = (Yv) =>
      Yv <= Y0 ? (Yv * Yt) / Y0 : Yt + (Yv - Y0) * (fm.sheenKeep ?? 1);
    for (let p = 0; p < N; p++)
      if (Fd[p * 4 + 3] > 0)
        filmL[p] = clamp(LofY(mapY(Yof(filmL[p]))), 0, 100);
    Ysheen0 = Yt;
    console.log(
      `film level matched to the front body: L* ${L0.toFixed(1)} -> ${Lt.toFixed(1)} (front body ${Math.round(fm.levelPct * 100)}th percentile), sheen kept x${fm.sheenKeep ?? 1}`,
    );
  }
  // Print area rule: inside the print area the film must stay dark enough for the pack's pale
  // ink (live text, odds, outline): its light is held under the level that gives the text
  // RECIPE.printContrast:1, by a smooth knee (values well under the cap are untouched, values
  // above approach it), and the hold fades out over RECIPE.printFade px outside the area, so the
  // edge sheen keeps its full height between the print area and the pack's edge.
  {
    const toL = (c) => toLin(c);
    const tc = hex(cfg.palette.text);
    const Yt = 0.2126 * toL(tc[0]) + 0.7152 * toL(tc[1]) + 0.0722 * toL(tc[2]);
    const Ycap = (Yt + 0.05) / RECIPE.printContrast - 0.05;
    const knee = Math.max(0.75 * Ycap, Ysheen0 * 1.02);
    const pa = {
      x0: bk.stripRight + off,
      x1: xR + off,
      y0: T0 + dy,
      y1: T1 + dy,
    };
    const F = RECIPE.printFade;
    let held = 0,
      peak = 0;
    if (cfg.printHold === false)
      console.log(
        'print area: hold off for this pack (config printHold: false)',
      );
    else if (Ycap > knee) {
      for (let Y = y0; Y <= y1; Y++)
        for (let X = 0; X < W; X++) {
          const p = Y * W + X;
          if (Fd[p * 4 + 3] === 0) continue;
          const dx = Math.max(pa.x0 - X, 0, X - pa.x1),
            dyy = Math.max(pa.y0 - Y, 0, Y - pa.y1);
          const d = Math.hypot(dx, dyy);
          if (d >= F) continue;
          const t = 1 - d / F,
            w = t * t * (3 - 2 * t);
          const Yv = Yof(filmL[p]);
          if (Yv <= knee) continue;
          const Yh =
            knee + (Ycap - knee) * (1 - Math.exp(-(Yv - knee) / (Ycap - knee)));
          const Yn = lerp(Yv, Yh, w);
          if (w > 0.999) {
            held++;
            peak = Math.max(peak, Yv);
          }
          filmL[p] = LofY(Yn);
        }
      console.log(
        `print area: film held under L* ${LofY(Ycap).toFixed(1)} (pale ink ${RECIPE.printContrast}:1, knee L* ${LofY(knee).toFixed(1)}), ${held} px inside it were brighter (up to L* ${LofY(peak).toFixed(1)}); fade ${F} px outside`,
      );
    }
  }
  for (let p = 0; p < N; p++) {
    if (Fd[p * 4 + 3] === 0) continue;
    const L = filmL[p];
    sheenY[p] = Yof(L) - Ysheen0;
    filmL[p] = clamp(L + grainAt(L) * grain[p], 0, 100);
  }

  // ---- 5. composite: film, panel, band, inks (sRGB float) ---------------------------------
  const linOf = (rgb) => rgb.map(toLin);
  const printRGB = (base, P, grainShare) => {
    // a print on the film: shares the film's sheen (linear light) and some of its grain
    const lin = linOf(base);
    const s = RECIPE.printSheen * sheenY[P];
    const rgb = lin.map((v) => fromLin(clamp(v + s, 0, 1)));
    if (!grainShare) return rgb;
    const l = rgb2lab(
      clamp(rgb[0], 0, 255),
      clamp(rgb[1], 0, 255),
      clamp(rgb[2], 0, 255),
    );
    return lab2rgb(clamp(l[0] + grainShare * fine[P], 0, 100), l[1], l[2]);
  };
  const out = new Float32Array(N * 3);
  const filmOnly = new Float32Array(N * 3);
  for (let p = 0; p < N; p++) {
    if (Fd[p * 4 + 3] === 0) {
      for (let c = 0; c < 3; c++) out[p * 3 + c] = Fd[p * 4 + c];
      continue;
    }
    const L = filmL[p];
    const [a, b] = chromaAt(L);
    let col = lab2rgb(L, a, b);
    if (filmOnly) for (let c = 0; c < 3; c++) filmOnly[p * 3 + c] = col[c];
    if (wP[p] > 0) {
      const pr = printRGB(pal.panel, p, RECIPE.printGrain);
      col = col.map((v, c) => lerp(v, pr[c], clamp(wP[p], 0, 1)));
    }
    if (wK[p] > 0) {
      const pr = printRGB(pal.band, p, RECIPE.printGrain);
      col = col.map((v, c) => lerp(v, pr[c], clamp(wK[p], 0, 1)));
    }
    for (let k = 0; k < 5; k++) {
      const t = wI[k][p];
      if (t <= 0) continue;
      const pr = printRGB(pal[INKS[k]], p, 0);
      col = col.map((v, c) => lerp(v, pr[c], clamp(t, 0, 1)));
    }
    for (let c = 0; c < 3; c++) out[p * 3 + c] = col[c];
  }
  const fw = new Float32Array(N); // share of each pixel copied from the front

  // ---- 6. fin seal from the front's crimp foil (match-back.cjs, crimp mode) ---------------
  const cRow0 = y0 + 4,
    cRow1 = Ct;
  const cm_ = ref.seamTexMargin ?? 60;
  const cCol0 = Math.ceil(cl) + cm_,
    cCol1 = Math.floor(cr) - cm_,
    cLen = cCol1 - cCol0;
  const sx0 = bk.seam[0] + off,
    sx1 = bk.seam[1] + off;
  const seamW = sx1 - sx0;
  const sampleF = (x, y) => {
    x = clamp(x, 0, W - 1);
    y = clamp(y, 0, H - 1);
    const x0_ = Math.floor(x),
      yy0 = Math.floor(y),
      x1_ = Math.min(W - 1, x0_ + 1),
      yy1 = Math.min(H - 1, yy0 + 1);
    const tx = x - x0_,
      ty = y - yy0;
    const o = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const a = Fd[(yy0 * W + x0_) * 4 + c],
        b = Fd[(yy0 * W + x1_) * 4 + c],
        d = Fd[(yy1 * W + x0_) * 4 + c],
        e = Fd[(yy1 * W + x1_) * 4 + c];
      o[c] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
    }
    return o;
  };
  // Optional (config seamFlatten): a front whose crimp carries big reflection spots (Silver)
  // would repeat them all along the fin when its columns are tiled; instead each crimp row
  // gives its median colour across the crimp, so the fin keeps the crimp's ridges and tones
  // without the spots (the 3D light adds the moving highlight).
  let seamRow = null;
  if (cfg.seamFlatten) {
    const rowsMed = [];
    for (let y = Math.floor(cRow0); y <= Math.ceil(cRow1) + 1; y++) {
      const v = [[], [], []];
      for (let x = cCol0; x <= cCol1; x++)
        for (let c = 0; c < 3; c++)
          v[c].push(Fd[(clamp(y, 0, H - 1) * W + x) * 4 + c]);
      rowsMed[y] = v.map((a) => median(a));
    }
    seamRow = (yf) => {
      const a = Math.floor(yf),
        t = yf - a;
      const r0 = rowsMed[a] || rowsMed[Math.floor(cRow0)],
        r1 = rowsMed[a + 1] || r0;
      return [0, 1, 2].map((c) => lerp(r0[c], r1[c], t));
    };
    console.log(
      'fin seal: crimp rows flattened to their median across the crimp',
    );
  }
  const midY = (Ct + Cb) / 2;
  const alongSeam = (Y) => {
    let t = Math.abs(Y - midY) + cLen * 0.5;
    t %= 2 * cLen;
    return cCol0 + (t < cLen ? t : 2 * cLen - t);
  };
  const seamW8 = (X) =>
    clamp(Math.min(X - (sx0 - 0.5), sx1 - 0.5 - X) / 1.5 + 0.5, 0, 1);
  for (let Y = Ct - 2; Y <= Cb + 2; Y++) {
    const v = alongSeam(Y);
    for (let X = sx0 - 2; X <= sx1 + 1; X++) {
      const w = seamW8(X);
      if (w <= 0) continue;
      const u = (X - sx0 + 0.5) / seamW;
      const s = seamRow
        ? seamRow(cRow0 + clamp(u, 0, 1) * (cRow1 - cRow0))
        : sampleF(v, cRow0 + clamp(u, 0, 1) * (cRow1 - cRow0));
      const p = (Y * W + X) * 3;
      for (let c = 0; c < 3; c++) out[p + c] = lerp(out[p + c], s[c], w);
      fw[Y * W + X] = lerp(fw[Y * W + X], 1, w);
    }
  }
  console.log(`fin seal: front crimp foil, cols ${sx0}-${sx1 - 1}`);

  // ---- 7. shared rim: the mirrored front's outer edge, fading inward ----------------------
  // The rim carries the front's edge lines, which run the length of the pack. Front art that
  // happens to cross the edge (a crack, a glow) is not rim: a row whose rim stands out from the
  // median of its own columns (+-30 rows) over several pixels takes, over the whole rim span,
  // the nearest clean rim row, so no front art is copied onto the back.
  const rimReach = ref.rim.solid + ref.rim.fade + 1;
  const rimSrc = new Float32Array(N * 3);
  for (let p = 0; p < N; p++)
    for (let c = 0; c < 3; c++) rimSrc[p * 3 + c] = Fd[p * 4 + c];
  const rimRows = [];
  {
    const R2 = 30,
      yLo = Ct + 40,
      yHi = Cb - 40;
    for (const side of [-1, 1]) {
      // the edge lines sit at fixed columns (the body edge is straight), so each rim column is
      // compared with its own median down the pack (+-R2 rows)
      const dev = new Uint8Array(H);
      for (let k = 0; k <= rimReach; k++) {
        for (let Y = yLo; Y <= yHi; Y++) {
          const x =
            side < 0 ? Math.round(ext.L[Y]) + k : Math.round(ext.R[Y]) - k;
          const vs = [];
          for (
            let j = Math.max(yLo - R2, Y - R2);
            j <= Math.min(yHi + R2, Y + R2);
            j += 2
          )
            vs.push(fL[j * W + x]);
          if (Math.abs(fL[Y * W + x] - median(vs)) > 10) dev[Y]++;
        }
      }
      // rows with art: 4+ rim pixels off their line, grown by 4 rows; each takes the nearest
      // clean rim row, reflected about the run's end (above first, else below), with the same
      // edge position, so the lines continue unbroken
      const bad = new Uint8Array(H);
      for (let Y = yLo; Y <= yHi; Y++)
        if (dev[Y] >= 4)
          for (let j = -4; j <= 4; j++)
            if (Y + j >= yLo && Y + j <= yHi) bad[Y + j] = 1;
      const edgeX = (Y) =>
        side < 0 ? Math.round(ext.L[Y]) : Math.round(ext.R[Y]);
      const clean = (s, yy) =>
        s >= yLo && s <= yHi && !bad[s] && edgeX(s) === edgeX(yy);
      for (let Y = yLo; Y <= yHi; Y++) {
        if (!bad[Y] || bad[Y - 1]) continue;
        let b = Y;
        while (b + 1 <= yHi && bad[b + 1]) b++;
        const a = Y;
        for (let yy = a; yy <= b; yy++) {
          let src = -1;
          for (let s = 0; s < 400 && src < 0; s++) {
            const up = a - 1 - (yy - a) - s,
              dn = b + 1 + (b - yy) + s;
            if (clean(up, yy)) src = up;
            else if (clean(dn, yy)) src = dn;
          }
          if (src < 0) continue; // no clean row: keep the front's own
          rimRows.push(yy);
          // same columns in both rows: the front's edge lines sit at fixed columns
          for (let k = -2; k <= rimReach; k++) {
            const x = side < 0 ? edgeX(yy) + k : edgeX(yy) - k;
            const q = yy * W + x,
              qs = src * W + x;
            for (let c = 0; c < 3; c++) rimSrc[q * 3 + c] = Fd[qs * 4 + c];
          }
        }
      }
    }
  }
  console.log(
    `rim: ${rimRows.length} rows with front art crossing the edge replaced by the clean rim rows beside them${rimRows.length ? ` (rows ${Math.min(...rimRows)}-${Math.max(...rimRows)})` : ''}`,
  );
  for (let Y = Ct; Y <= Cb; Y++) {
    if (mL[Y] == null) continue;
    for (let X = 0; X < W; X++) {
      const d = Math.min(X - ext.L[Y], ext.R[Y] - X);
      const w =
        d <= ref.rim.solid
          ? 1
          : d >= ref.rim.solid + ref.rim.fade
            ? 0
            : 1 - (d - ref.rim.solid) / ref.rim.fade;
      if (w <= 0) continue;
      const p = (Y * W + X) * 3,
        ws = w * w * (3 - 2 * w);
      for (let c = 0; c < 3; c++)
        out[p + c] = lerp(out[p + c], rimSrc[p + c], ws);
      fw[Y * W + X] = lerp(fw[Y * W + X], 1, ws);
    }
  }

  // ---- 8. the front's crimps, full strength, short feather + contact shadow --------------
  const fe = ref.feather;
  const crimpW = (Y) => {
    const d = Math.min(Y - Ct, Cb - Y);
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
      fw[Y * W + X] = lerp(fw[Y * W + X], 1, w);
    }
  }

  // ---- write: dithered RGB + the mirrored front's alpha, byte for byte ---------------------
  const drand = prng(RECIPE.seed + 1000);
  const png = Buffer.alloc(N * 4);
  for (let p = 0; p < N; p++) {
    const amp = 1 - fw[p];
    for (let c = 0; c < 3; c++) {
      const d = amp > 0 ? (drand() - drand()) * amp : 0;
      png[p * 4 + c] = Math.round(clamp(out[p * 3 + c] + d, 0, 255));
    }
    png[p * 4 + 3] = Fd[p * 4 + 3];
  }
  const plateFile = path.join(
    cfg.outDir,
    `${cfg.name}-back-plate${VARIANT ? `-${VARIANT}` : ''}.png`,
  );
  await sharp(png, { raw: { width: W, height: H, channels: 4 } })
    .png({ compressionLevel: 9 })
    .toFile(plateFile);
  console.log('wrote', path.relative(process.cwd(), plateFile));

  // ---- checks --------------------------------------------------------------------------
  const chk = await rawRGBA(plateFile);
  let aDiff = 0;
  for (let p = 0; p < N; p++)
    if (chk.data[p * 4 + 3] !== Fd[p * 4 + 3]) aDiff++;
  if (aDiff > 0)
    throw new Error(`alpha differs from the mirrored front in ${aDiff} px`);
  // print moved by whole pixels only: every ink coverage in the text box equals the
  // reference's coverage at (X - off, Y - dy), exactly
  let inkDiff = 0,
    inkPx = 0;
  for (let Y = T0 + dy; Y <= T1 + dy; Y++)
    for (let X = bk.stripRight + off + 1; X <= xR + off - 1; X++) {
      const P = Y * W + X,
        q = (Y - dy) * W + (X - off);
      for (let k = 0; k < 5; k++) {
        if (aI[k][q] > 0) inkPx++;
        if (wI[k][P] !== aI[k][q]) inkDiff++;
      }
    }
  if (inkDiff > 0) throw new Error(`ink coverage resampled in ${inkDiff} px`);
  // live zones in the target frame
  const liveOut = liveRef.map((r) => ({
    x0: r.x0 + off,
    x1: r.x1 + off,
    y0: r.y0 + dy,
    y1: r.y1 + dy,
  }));
  // every zone pixel is the plain film synthesised for that spot (only dither differs)
  let zoneInk = 0,
    zoneDiff = 0,
    zonePx = 0;
  for (const r of liveOut)
    for (let Y = r.y0; Y < r.y1; Y++)
      for (let X = r.x0; X < r.x1; X++) {
        const P = Y * W + X;
        zonePx++;
        for (let k = 0; k < 5; k++) if (wI[k][P] > 0) zoneInk++;
        for (let c = 0; c < 3; c++)
          zoneDiff = Math.max(
            zoneDiff,
            Math.abs(chk.data[P * 4 + c] - filmOnly[P * 3 + c]),
          );
      }
  if (zoneInk > 0)
    throw new Error(`ink coverage left in the live zones: ${zoneInk} px`);
  if (zoneDiff > 2)
    throw new Error(`live zones differ from plain film by ${zoneDiff} levels`);
  console.log(
    `check: alpha mismatch ${aDiff} px; ink coverage px in the text box ${inkPx}, resampled ${inkDiff}; live zones ${zonePx} px: ink coverage 0, largest difference from the plain film ${zoneDiff.toFixed(2)} levels (dither)`,
  );

  // legibility: contrast ratio (WCAG formula) of each ink against what it is printed on
  {
    const Ylin = (rgb) =>
      0.2126 * toLin(rgb[0]) + 0.7152 * toLin(rgb[1]) + 0.0722 * toLin(rgb[2]);
    const ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    // per wording item, over its glyph pixels (ink coverage > 0.5): the ink as printed (with
    // the film's sheen) against the film synthesised under it; median and worst 5%
    const film = (P) =>
      Ylin([0, 1, 2].map((c) => clamp(filmOnly[P * 3 + c], 0, 255)));
    const item = (k, box) => {
      const r = [];
      for (let Y = box.y0 + dy; Y < box.y1 + dy; Y++)
        for (let X = box.x0 + off; X < box.x1 + off; X++) {
          const P = Y * W + X;
          if (wI[k][P] <= 0.5) continue;
          const ink = Ylin(
            printRGB(pal[INKS[k]], P, 0).map((v) => clamp(v, 0, 255)),
          );
          r.push(ratio(ink, film(P)));
        }
      r.sort((a, b) => a - b);
      return r.length
        ? `${r[r.length >> 1].toFixed(1)}:1 (worst 5% ${r[Math.floor(r.length * 0.05)].toFixed(1)}:1)`
        : 'n/a';
    };
    const odds = { x0: 570, x1: 849, y0: 822, y1: 1452 };
    console.log(
      `contrast: headline + paragraph ${item(3, REF.filmInkBoxes[0])}; Pull odds heading ${item(3, odds)}; odds outline ${item(4, odds)}; band ink on band ${ratio(Ylin(pal.bandInk), Ylin(pal.band)).toFixed(1)}:1; logo on panel ${ratio(Ylin(pal.panelInk), Ylin(pal.panel)).toFixed(1)}:1`,
    );
  }

  // ---- geometry ------------------------------------------------------------------------
  const r5 = (v) => +v.toFixed(5),
    r4 = (v) => +v.toFixed(4);
  let bx0 = W,
    bx1 = -1;
  for (let p = 0; p < N; p++)
    if (Fd[p * 4 + 3] >= 128) {
      const x = p % W;
      if (x < bx0) bx0 = x;
      if (x > bx1) bx1 = x;
    }
  const geo = {
    pack: cfg.name,
    image: { width: W, height: H, file: `${cfg.name}-back-plate.png` },
    note: 'Fractions of image width (x) and height (y). The back is the front mirrored left-right: x here = 1 - x on the front.',
    alphaThreshold: 128,
    alphaInterior: (() => {
      const v = [];
      for (let Y = Ct + 40; Y <= Cb - 40; Y += 7)
        for (let X = Math.ceil(ext.L[Y]) + 30; X <= ext.R[Y] - 30; X += 7)
          v.push(Fd[(Y * W + X) * 4 + 3]);
      const m = median(v);
      return `${m} (${(m / 255).toFixed(3)}), copied from the front`;
    })(),
    bounds: {
      x0: r4(bx0 / W),
      x1: r4((bx1 + 1) / W),
      y0: r4(y0 / H),
      y1: r4((y1 + 1) / H),
    },
    body: {
      x0: r4(mL[(Ct + Cb) >> 1] / W),
      x1: r4((mR[(Ct + Cb) >> 1] + 1) / W),
      note: 'straight side edges between the shoulders',
    },
    crimpTop: { y0: r4(y0 / H), y1: r4(Ct / H) },
    crimpBottom: { y0: r4(Cb / H), y1: r4((y1 + 1) / H) },
    finSeal: { x0: r4(sx0 / W), x1: r4(sx1 / W), mode: 'crimp' },
    printArea: {
      x0: r4((bk.stripRight + off) / W),
      x1: r4((xR + off) / W),
      y0: r4((T0 + dy) / H),
      y1: r4((T1 + dy) / H),
    },
    printZones: {
      ...refGeo.printZones,
      note: `Live-text zones: rectangles (fractions of width x and height y, half-open), the reference's zones moved by this pack's whole-pixel shift (off ${off}, dy ${dy}). On this plate the zones with plate=live are already blank (restyle-back.cjs gives them no ink); the print module draws there. Text runs sideways, reading bottom to top. plate=no-odds marks the fixed odds heading, which is kept on this plate.`,
      zones: zonesRef.map(({ px, ...z }) => ({
        ...z,
        rect: {
          x0: r5((px.x0 + off) / W),
          x1: r5((px.x1 + off) / W),
          y0: r5((px.y0 + dy) / H),
          y1: r5((px.y1 + dy) / H),
        },
      })),
    },
    restyle: {
      tool: 'scripts/pack-back/restyle-back.cjs',
      reference: ref.name,
      shift: { off, dy },
      palette: cfg.palette,
      film: { level: r4(L0) },
    },
  };
  // the zones must land on the same pixels when read back with round(fraction * size)
  for (const z of geo.printZones.zones) {
    const src = zonesRef.find((s) => s.id === z.id).px;
    if (
      Math.round(z.rect.x0 * W) !== src.x0 + off ||
      Math.round(z.rect.x1 * W) !== src.x1 + off ||
      Math.round(z.rect.y0 * H) !== src.y0 + dy ||
      Math.round(z.rect.y1 * H) !== src.y1 + dy
    )
      throw new Error(`zone ${z.id} does not round-trip`);
  }
  if (!VARIANT) {
    // the layout is what readers depend on: when only the record under `restyle` (palette,
    // film notes) would change, the existing file is kept byte for byte
    const gFile = path.join(cfg.outDir, `${cfg.name}-back-geometry.json`);
    const strip = (g) => JSON.stringify({ ...g, restyle: undefined });
    const prev = fs.existsSync(gFile)
      ? JSON.parse(fs.readFileSync(gFile, 'utf8'))
      : null;
    if (prev && strip(prev) === strip(geo))
      console.log(
        'geometry: layout unchanged, existing file kept byte for byte',
      );
    else fs.writeFileSync(gFile, JSON.stringify(geo, null, 2) + '\n');
  }
  console.log(
    'zones (px): ' +
      geo.printZones.zones
        .map(
          (z) =>
            `${z.id} ${Math.round(z.rect.x0 * W)}-${Math.round(z.rect.x1 * W)} x ${Math.round(z.rect.y0 * H)}-${Math.round(z.rect.y1 * H)}`,
        )
        .join('; '),
  );

  if (DEBUG) {
    const dump = async (name, fn) => {
      const b = Buffer.alloc(N * 3);
      for (let p = 0; p < N; p++) {
        const v = fn(p);
        for (let c = 0; c < 3; c++)
          b[p * 3 + c] = Math.round(clamp(v[c], 0, 255));
      }
      await sharp(b, { raw: { width: W, height: H, channels: 3 } })
        .png()
        .toFile(path.join(cfg.workDir, name));
    };
    await dump('film.png', (p) => [
      filmOnly[p * 3],
      filmOnly[p * 3 + 1],
      filmOnly[p * 3 + 2],
    ]);
    await dump('layers.png', (p) => [
      wP[p] * 255,
      wK[p] * 255,
      Math.min(
        1,
        wI.reduce((s, a) => s + a[p], 0),
      ) * 255,
    ]);
    await dump('ref-layers.png', (p) => [
      aP[p] * 255,
      aK[p] * 255,
      Math.min(
        1,
        aI.reduce((s, a) => s + a[p], 0),
      ) * 255,
    ]);
    console.log('debug images in', cfg.workDir);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
