/* eslint-disable @typescript-eslint/no-require-imports -- a CommonJS node tool */
// Builds the storefront's 3D pack catalogue from the approved research files
// (docs/research/home-3d/pack-back/, gitignored, so this runs only on the
// machine that has them). Re-run it whenever a front, plate or setting there
// changes; never edit the outputs by hand.
//
//   node scripts/pack-back/build-pack-3d-catalog.cjs [--modules-only]
//
// Writes
//   public/pack-3d/<id>/front.webp       the front the back was cut from
//   public/pack-3d/<id>/back.webp        the back plate (live-text zones blank)
//   public/pack-3d/<id>/front-half.webp  half size, for phones
//   public/pack-3d/<id>/back-half.webp
//   src/components/pack-3d/catalog/pack-3d-manifest.ts  URLs (?v=content hash)
//                                                        and pixel sizes
//   src/components/pack-3d/catalog/pack-3d-settings.ts  geometry, print
//                                                        geometry, ink, material
//   docs/research/home-3d/pack-3d/catalog/encode-proof.json
//
// Every setting is read from the file the approved renders used
// (docs/research/home-3d/pack-3d/harness-text/server.cjs + raw.js):
//   PackGeometry   <pack>-pack-geometry.json (151: PACK_151_GEOMETRY, imported)
//   back geometry  <pack>-back-geometry.json (151-back-geometry.json)
//   ink            the ink each approved render recorded (live-text/*/report.json)
//   material       <pack>-material.json foil + relief (graded); none for 151 and
//                  the raw four, which rendered with createPackModel's defaults
//
// Encoding. Fronts: the WebP bytes as they are; a PNG front is converted
// losslessly (exact). Backs: lossless WebP is ~1.3 MB a pack, so the backs are
// near-lossless: every visible pixel's RGB is moved to the nearest value on a
// step-4 grid anchored at the pack's own ink (so the ink level is a fixed
// point), never by more than 2 levels; pixels at least 0.9x the ink's luminance
// (the fixed wording's stroke interiors) and every pixel with alpha under 224
// (the cut-out rim, and transparent pixels) are kept exactly; alpha is never
// touched. The result is then coded lossless (exact).
// libwebp's own near_lossless mode is not used: it also quantises alpha
// (hundreds of thousands of pixels on 151) and moves visible RGB up to 255.
// Halves: the front resized (lanczos3) and coded lossy q90 with lossless alpha;
// the back resized in mirrored space (so its alpha is the half front's,
// mirrored) and coded lossless. Each step is checked on the decoded file and the
// script exits non-zero if any check fails.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const repo = path.resolve(__dirname, '..', '..');
const sharp = require(path.join(repo, 'node_modules', 'sharp'));
const PB = path.join(repo, 'docs/research/home-3d/pack-back');
const LT = path.join(repo, 'docs/research/home-3d/pack-3d/live-text');
const PUBLIC = path.join(repo, 'public/pack-3d');
const CATALOG = path.join(repo, 'src/components/pack-3d/catalog');
const PROOF = path.join(
  repo,
  'docs/research/home-3d/pack-3d/catalog/encode-proof.json',
);
const MODULES_ONLY = process.argv.includes('--modules-only');
// The near-lossless settings the shipped backs were made with (fixed, so a
// re-run reproduces the same files). Tried 2026-11-19 and rejected: step 3,
// and keeping 1-2 px around the pale wording exact (bigger files, and the
// softness match moved MORE on some packs: that statistic is noisy at this
// level).
const STEP = 4;
const PALE = 0.9;
const DILATE = 0;
// below this alpha (the cut-out rim) pixels stay exact; 151's interior is ~251
const RIM_ALPHA = 224;

const RAW = ['151', 'cr', 'delta-reign', '30th-celebration', 'ah'];
const GRADED = [
  'bronze-pack',
  'silver-pack',
  'gold-pack',
  'platinum-pack',
  'diamond-pack',
  'poncho-pack',
];
const IDS = [...RAW, ...GRADED];
// how the plate agent brought 151's art to each front (for the body-copy rect)
const SCALE = { cr: 0.931, '30th-celebration': 0.787 };

const dirOf = (id) => (id === '151' ? PB : path.join(PB, id));
const src = (id) => ({
  front: path.join(
    PB,
    'fronts',
    id === '30th-celebration' ? `${id}-front.png` : `${id}-front.webp`,
  ),
  plate: path.join(dirOf(id), `${id}-back-plate.png`),
  back: path.join(dirOf(id), `${id}-back-geometry.json`),
  pack: id === '151' ? null : path.join(dirOf(id), `${id}-pack-geometry.json`),
  material: GRADED.includes(id)
    ? path.join(dirOf(id), `${id}-material.json`)
    : null,
});
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const sha8 = (buf) =>
  crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
const failures = [];
const check = (ok, msg) => {
  if (!ok) failures.push(msg);
  return ok;
};

async function rgba(input) {
  const { data, info } = await sharp(input)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { d: data, W: info.width, H: info.height };
}
const fromRaw = (img) =>
  sharp(img.d, { raw: { width: img.W, height: img.H, channels: 4 } });

/** Pixels whose alpha differs from the other image's alpha mirrored left-right. */
function alphaMirrorDiff(a, b) {
  if (a.W !== b.W || a.H !== b.H) return -1;
  let n = 0;
  for (let y = 0; y < a.H; y++)
    for (let x = 0; x < a.W; x++)
      if (a.d[(y * a.W + x) * 4 + 3] !== b.d[(y * a.W + (a.W - 1 - x)) * 4 + 3])
        n++;
  return n;
}
function compare(a, b, rect) {
  let alpha = 0,
    max = 0,
    maxIn = 0,
    changed = 0;
  const inRect = (x, y) =>
    rect && x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1;
  for (let y = 0; y < a.H; y++)
    for (let x = 0; x < a.W; x++) {
      const p = (y * a.W + x) * 4;
      if (a.d[p + 3] !== b.d[p + 3]) alpha++;
      const d = Math.max(
        Math.abs(a.d[p] - b.d[p]),
        Math.abs(a.d[p + 1] - b.d[p + 1]),
        Math.abs(a.d[p + 2] - b.d[p + 2]),
      );
      if (d) changed++;
      if (a.d[p + 3] > 0 && d > max) max = d;
      if (inRect(x, y) && d > maxIn) maxIn = d;
    }
  return { alpha, max, maxIn, changed };
}
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const lumOf = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** The near-lossless step (see top). Returns a new image. */
function quantize(img, ink) {
  const out = Buffer.from(img.d);
  const anchor = hexRgb(ink.color);
  const paleL = PALE * lumOf(...anchor);
  const { W, H } = img;
  // kept exact: pale pixels and everything within DILATE px of one
  const pale = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++)
    if (lumOf(img.d[i * 4], img.d[i * 4 + 1], img.d[i * 4 + 2]) >= paleL)
      pale[i] = 1;
  const keep = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (!pale[y * W + x]) continue;
      for (let dy = -DILATE; dy <= DILATE; dy++)
        for (let dx = -DILATE; dx <= DILATE; dx++) {
          const yy = y + dy,
            xx = x + dx;
          if (yy >= 0 && yy < H && xx >= 0 && xx < W) keep[yy * W + xx] = 1;
        }
    }
  for (let p = 0; p < out.length; p += 4) {
    // the rim: a canvas stores premultiplied 8-bit colour, so at low alpha a
    // 2-level change can come back as a much larger one (and the shader
    // divides by alpha); keep every partly transparent rim pixel exact
    if (img.d[p + 3] < RIM_ALPHA) continue;
    if (keep[p / 4]) continue;
    for (let c = 0; c < 3; c++) {
      const v = img.d[p + c];
      const a = anchor[c] % STEP;
      let q = a + STEP * Math.round((v - a) / STEP);
      if (q > 255) q -= STEP;
      if (q < 0) q += STEP;
      out[p + c] = Math.abs(q - v) <= Math.floor(STEP / 2) ? q : v;
    }
  }
  return { d: out, W: img.W, H: img.H };
}

// --- the measurements that set the ink (harness-text/measure-raw.cjs and
// white-plateau.cjs, the same statistics on the same rectangles) -------------
const lumAt = (img, x, y) => {
  const q = (y * img.W + x) * 4;
  return lumOf(img.d[q], img.d[q + 1], img.d[q + 2]);
};
const pct = (arr, q) => {
  const a = [...arr].sort((m, n) => m - n);
  return a[Math.min(a.length - 1, Math.floor(q * a.length))];
};
const plateauOf = (vals, lo) => {
  const max = Math.max(...vals);
  return pct(
    vals.filter((v) => v > lo + 0.6 * (max - lo)),
    0.5,
  );
};
function edgeWidth(img, rect) {
  const ink = (x, y) => lumAt(img, x, y);
  const vals = [];
  for (let y = rect.y0; y < rect.y1; y++)
    for (let x = rect.x0; x < rect.x1; x++) vals.push(ink(x, y));
  const lo = pct(vals, 0.3),
    hi = plateauOf(vals, lo);
  const t10 = lo + 0.1 * (hi - lo),
    t90 = lo + 0.9 * (hi - lo);
  const widths = [];
  const scan = (get, n) => {
    for (let i = 1; i < n; i++) {
      if (get(i - 1) < t10 && get(i) >= t10) {
        let j = i;
        while (j < n && j - i < 6 && get(j) < t90 && get(j) >= get(j - 1)) j++;
        if (j < n && get(j) >= t90) {
          const x10 = i - 1 + (t10 - get(i - 1)) / (get(i) - get(i - 1));
          const x90 = j - 1 + (t90 - get(j - 1)) / (get(j) - get(j - 1));
          widths.push(x90 - x10);
        }
      }
    }
  };
  for (let y = rect.y0; y < rect.y1; y++) {
    scan((i) => ink(rect.x0 + i, y), rect.x1 - rect.x0);
    scan((i) => ink(rect.x1 - 1 - i, y), rect.x1 - rect.x0);
  }
  for (let x = rect.x0; x < rect.x1; x++) {
    scan((i) => ink(x, rect.y0 + i), rect.y1 - rect.y0);
    scan((i) => ink(x, rect.y1 - 1 - i), rect.y1 - rect.y0);
  }
  return widths.reduce((a, b) => a + b, 0) / Math.max(1, widths.length);
}
function wordingRects(img, geo, id) {
  const z = Object.fromEntries(geo.printZones.zones.map((q) => [q.id, q.rect]));
  const hr = z.headline,
    s = SCALE[id] ?? 1;
  const ax = (x) => Math.round(hr.x0 * img.W + s * (x - 586));
  const ay = (y) => Math.round(hr.y1 * img.H + s * (y - 1430));
  const h = z.oddsHeading;
  return {
    heading: {
      x0: Math.round(h.x0 * img.W),
      x1: Math.round(h.x1 * img.W),
      y0: Math.round(h.y0 * img.H),
      y1: Math.round(h.y1 * img.H),
    },
    body: { x0: ax(200), x1: ax(296), y0: ay(740), y1: ay(1445) },
  };
}
function wordingInk(img, rect) {
  const px = [];
  for (let y = rect.y0; y < rect.y1; y++)
    for (let x = rect.x0; x < rect.x1; x++) {
      const q = (y * img.W + x) * 4;
      px.push([img.d[q], img.d[q + 1], img.d[q + 2], lumAt(img, x, y)]);
    }
  px.sort((m, n) => m[3] - n[3]);
  const ground = px[Math.floor(px.length / 2)][3],
    max = px[px.length - 1][3];
  const ink = px.filter((v) => v[3] > ground + 0.6 * (max - ground));
  const hex = (band) =>
    '#' +
    [0, 1, 2]
      .map((c) =>
        Math.round(band.reduce((s2, v) => s2 + v[c], 0) / band.length)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('');
  return {
    // measure-raw.cjs: mean RGB of the 40-90th luminance percentile of inked pixels
    peak: hex(
      ink.slice(
        Math.floor(ink.length * 0.4),
        Math.max(
          Math.floor(ink.length * 0.4) + 1,
          Math.floor(ink.length * 0.9),
        ),
      ),
    ),
    // white-plateau.cjs: mean RGB of the 80-95th percentile band, and the median
    plateau: hex(
      ink.slice(Math.floor(0.8 * ink.length), Math.floor(0.95 * ink.length)),
    ),
    p50: Number(ink[Math.floor(0.5 * ink.length)][3].toFixed(2)),
  };
}
function plateMeasures(img, geo, id) {
  const r = wordingRects(img, geo, id);
  return {
    heading: wordingInk(img, r.heading),
    body: wordingInk(img, r.body),
    headingEdge: edgeWidth(img, r.heading),
  };
}
/** measure-raw.cjs's matched softness: where price edge / heading edge equals 151's at 0.35. */
function matchSoftness(priceBySoftness, headingEdge, ratio151) {
  const pts = Object.entries(priceBySoftness)
    .map(([s, w]) => [Number(s), w / headingEdge])
    .sort((x, y) => x[0] - y[0]);
  for (let i = 1; i < pts.length; i++) {
    const [s0, r0] = pts[i - 1],
      [s1, r1] = pts[i];
    if ((r0 - ratio151) * (r1 - ratio151) <= 0 && r1 !== r0)
      return s0 + ((ratio151 - r0) * (s1 - s0)) / (r1 - r0);
  }
  return null;
}

// --- settings ------------------------------------------------------------------
function inkUsed() {
  const out = {};
  for (const dir of ['raw-packs', 'graded-packs']) {
    const rep = readJson(path.join(LT, dir, 'report.json'));
    for (const id of dir === 'raw-packs' ? RAW : GRADED) {
      if (!rep[id]) throw new Error(`${dir}/report.json has no ${id}`);
      out[id] = { color: rep[id].ink.color, softness: rep[id].ink.softness };
    }
  }
  return out;
}
const pick = (o, keys) =>
  Object.fromEntries(
    keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]),
  );
function packGeometry(json) {
  const g = {
    pack: json.pack,
    image: pick(json.image, ['width', 'height']),
    alphaThreshold: json.alphaThreshold,
    bounds: pick(json.bounds, ['x0', 'x1', 'y0', 'y1']),
    body: pick(json.body, ['x0', 'x1']),
    crimpTop: pick(json.crimpTop, ['y0', 'y1']),
    crimpBottom: pick(json.crimpBottom, ['y0', 'y1']),
    finSeal: pick(json.finSeal, ['x0', 'x1']),
  };
  if (json.printArea)
    g.printArea = pick(json.printArea, ['x0', 'x1', 'y0', 'y1']);
  if (json.outline) g.outline = json.outline;
  if (json.edges) g.edges = pick(json.edges, ['top', 'bottom']);
  if (json.ridges)
    g.ridges = Object.fromEntries(
      Object.entries(json.ridges).map(([k, r]) => [
        k,
        pick(r, ['from', 'to', 'pitch', 'crest']),
      ]),
    );
  return g;
}
const backGeometry = (json) => ({
  image: pick(json.image, ['width', 'height']),
  printZones: {
    zones: json.printZones.zones.map((z) => ({
      id: z.id,
      plate: z.plate,
      rect: pick(z.rect, ['x0', 'x1', 'y0', 'y1']),
    })),
  },
});

/** Median alpha of the front's opaque interior (alpha >= 128, away from the rim). */
function interiorAlpha(img) {
  const vals = [];
  for (let y = Math.round(img.H * 0.2); y < Math.round(img.H * 0.8); y += 3)
    for (
      let x = Math.round(img.W * 0.15);
      x < Math.round(img.W * 0.85);
      x += 3
    ) {
      const a = img.d[(y * img.W + x) * 4 + 3];
      if (a >= 128) vals.push(a);
    }
  return pct(vals, 0.5);
}

// --- pictures ------------------------------------------------------------------
async function encodePictures(id, ink, geoBack, measureJson) {
  const s = src(id);
  const out = path.join(PUBLIC, id);
  fs.mkdirSync(out, { recursive: true });
  const files = {
    front: path.join(out, 'front.webp'),
    back: path.join(out, 'back.webp'),
    frontHalf: path.join(out, 'front-half.webp'),
    backHalf: path.join(out, 'back-half.webp'),
  };
  const proof = { id, encoding: {} };

  // front
  const frontSrc = await rgba(s.front);
  if (s.front.endsWith('.webp')) {
    fs.copyFileSync(s.front, files.front);
    proof.encoding.front = 'source WebP bytes, unchanged';
    check(
      sha8(fs.readFileSync(files.front)) === sha8(fs.readFileSync(s.front)),
      `${id}: front bytes differ from source`,
    );
  } else {
    await fromRaw(frontSrc)
      .webp({ lossless: true, exact: true, effort: 6 })
      .toFile(files.front);
    const c = compare(frontSrc, await rgba(files.front));
    proof.encoding.front = 'PNG converted to lossless WebP (exact)';
    proof.frontLossless = c;
    check(
      c.alpha === 0 && c.changed === 0,
      `${id}: lossless front is not the PNG pixel for pixel (${JSON.stringify(c)})`,
    );
  }
  const front = await rgba(files.front);
  proof.frontInteriorAlpha = interiorAlpha(front);

  // back
  const plate = await rgba(s.plate);
  check(
    plate.W === front.W && plate.H === front.H,
    `${id}: plate ${plate.W}x${plate.H} vs front ${front.W}x${front.H}`,
  );
  const pa = geoBack.printArea;
  const printRect = {
    x0: Math.floor(pa.x0 * plate.W),
    x1: Math.ceil(pa.x1 * plate.W),
    y0: Math.floor(pa.y0 * plate.H),
    y1: Math.ceil(pa.y1 * plate.H),
  };
  const lossless = await fromRaw(plate)
    .webp({ lossless: true, exact: true, effort: 6 })
    .toBuffer();
  const q = quantize(plate, ink);
  await fromRaw(q)
    .webp({ lossless: true, exact: true, effort: 6 })
    .toFile(files.back);
  const back = await rgba(files.back);
  const qc = compare(q, back);
  check(
    qc.alpha === 0 && qc.changed === 0,
    `${id}: lossless coding of the quantised back is not exact`,
  );
  const c = compare(plate, back, printRect);
  proof.encoding.back = `near-lossless: RGB on a step-${STEP} grid anchored at ${ink.color}, pale (>= ${PALE} x ink luminance, and within ${DILATE} px of one) and alpha < ${RIM_ALPHA} pixels exact, alpha untouched; then lossless WebP (exact)`;
  proof.back = {
    losslessBytes: lossless.length,
    bytes: fs.statSync(files.back).size,
    alphaDiffPx: c.alpha,
    maxChannelDiffVisible: c.max,
    maxChannelDiffPrintArea: c.maxIn,
    changedPx: c.changed,
    pixels: plate.W * plate.H,
  };
  check(c.alpha === 0, `${id}: back alpha changed on ${c.alpha} px`);
  check(
    c.max <= 2 && c.maxIn <= 2,
    `${id}: back channel difference ${c.max} (print area ${c.maxIn}) > 2`,
  );

  // the ink, re-measured on the decoded back with the tools that set it
  const mPng = plateMeasures(plate, geoBack, id);
  const mWebp = plateMeasures(back, geoBack, id);
  // the colours must be identical; the median luminance (p50) is reported
  const colours = (m) =>
    [m.heading.peak, m.heading.plateau, m.body.peak, m.body.plateau].join();
  const same = colours(mPng) === colours(mWebp);
  check(
    same,
    `${id}: fixed wording's colour measures differently after encoding`,
  );
  proof.ink = {
    table: ink,
    png: { heading: mPng.heading, body: mPng.body },
    webp: { heading: mWebp.heading, body: mWebp.body },
    identical: same,
    headingEdge: { png: mPng.headingEdge, webp: mWebp.headingEdge },
  };

  // alpha pairs
  proof.alphaMirror = { full: alphaMirrorDiff(back, front) };
  check(
    proof.alphaMirror.full === 0,
    `${id}: back alpha is not the front's mirrored (${proof.alphaMirror.full} px)`,
  );

  // halves
  const hw = Math.round(front.W / 2),
    hh = Math.round(front.H / 2);
  const frontHalfRaw = await rgba(
    await fromRaw(front)
      .resize(hw, hh, { kernel: 'lanczos3', fit: 'fill' })
      .png()
      .toBuffer(),
  );
  await fromRaw(frontHalfRaw)
    .webp({ quality: 90, alphaQuality: 100, exact: true, effort: 6 })
    .toFile(files.frontHalf);
  const frontHalf = await rgba(files.frontHalf);
  const fhc = compare(frontHalfRaw, frontHalf);
  proof.frontHalf = {
    bytes: fs.statSync(files.frontHalf).size,
    size: [hw, hh],
    alphaDiffVsResize: fhc.alpha,
  };
  check(fhc.alpha === 0, `${id}: half front's alpha is not lossless`);
  // the back resized in the front's frame (mirrored), then mirrored back
  // (three separate pipelines: sharp applies flop once per pipeline, whatever
  // the call order, so .flop().resize().flop() is NOT a round trip)
  const mirrored = await rgba(await fromRaw(plate).flop().png().toBuffer());
  const mirroredHalf = await rgba(
    await fromRaw(mirrored)
      .resize(hw, hh, { kernel: 'lanczos3', fit: 'fill' })
      .png()
      .toBuffer(),
  );
  let backHalfRaw = await rgba(
    await fromRaw(mirroredHalf).flop().png().toBuffer(),
  );
  // sanity: the same picture as a plain resize of the plate (within resampling)
  const plain = await rgba(
    await fromRaw(plate)
      .resize(hw, hh, { kernel: 'lanczos3', fit: 'fill' })
      .png()
      .toBuffer(),
  );
  let plainSum = 0;
  for (let i = 0; i < plain.d.length; i++)
    plainSum += Math.abs(plain.d[i] - backHalfRaw.d[i]);
  const plainMean = plainSum / plain.d.length;
  check(
    plainMean < 2,
    `${id}: half back is not the plate resized (mean diff ${plainMean.toFixed(2)})`,
  );
  let copied = 0;
  if (alphaMirrorDiff(backHalfRaw, frontHalf) !== 0) {
    // not mirror-symmetric after all: take the alpha from the half front
    const d = Buffer.from(backHalfRaw.d);
    for (let y = 0; y < hh; y++)
      for (let x = 0; x < hw; x++) {
        const p = (y * hw + x) * 4,
          m = (y * hw + (hw - 1 - x)) * 4 + 3;
        if (d[p + 3] !== frontHalf.d[m]) copied++;
        d[p + 3] = frontHalf.d[m];
      }
    backHalfRaw = { d, W: hw, H: hh };
  }
  await fromRaw(backHalfRaw)
    .webp({ lossless: true, exact: true, effort: 6 })
    .toFile(files.backHalf);
  const backHalf = await rgba(files.backHalf);
  const bhc = compare(backHalfRaw, backHalf);
  check(
    bhc.alpha === 0 && bhc.changed === 0,
    `${id}: half back is not lossless`,
  );
  proof.backHalf = {
    bytes: fs.statSync(files.backHalf).size,
    size: [hw, hh],
    alphaPxCopiedFromFront: copied,
    meanDiffVsPlainResize: Number(plainMean.toFixed(3)),
  };
  proof.alphaMirror.half = alphaMirrorDiff(backHalf, frontHalf);
  check(
    proof.alphaMirror.half === 0,
    `${id}: half back alpha is not the half front's mirrored`,
  );
  proof.bytes = Object.fromEntries(
    Object.entries(files).map(([k, f]) => [k, fs.statSync(f).size]),
  );
  return { proof, mPng, mWebp };
}

// --- modules -----------------------------------------------------------------------
async function writeModules(settings, pictures) {
  const prettier = require(path.join(repo, 'node_modules', 'prettier'));
  const cfg = {
    ...(await prettier.resolveConfig(path.join(CATALOG, 'x.ts'))),
    parser: 'typescript',
  };
  const header = (what) =>
    `// GENERATED by scripts/pack-back/build-pack-3d-catalog.cjs from the approved\n// research files. Do not edit by hand: change the source and re-run it.\n//\n// ${what}\n`;

  const manifest = {};
  for (const id of IDS) {
    const p = pictures[id];
    const url = (name) => `/pack-3d/${id}/${name}.webp?v=${p.hash[name]}`;
    manifest[id] = {
      front: url('front'),
      frontHalf: url('front-half'),
      back: url('back'),
      backHalf: url('back-half'),
      width: p.size.width,
      height: p.size.height,
      halfWidth: p.half.width,
      halfHeight: p.half.height,
    };
  }
  const m =
    header(
      "Which packs have a bundled 3D set, its picture URLs (each with a content\n// version, ?v=<first 8 hex of the file's sha256>) and pixel sizes. Data only:\n// no three.js, safe for server components and the main bundle.",
    ) +
    `\nimport type { Pack3dAssets } from './pack-3d-types';\n\n` +
    `export const PACK_3D_ASSETS: Readonly<Record<string, Pack3dAssets>> = ${JSON.stringify(manifest, null, 2)};\n`;
  fs.writeFileSync(
    path.join(CATALOG, 'pack-3d-manifest.ts'),
    await prettier.format(m, cfg),
  );

  const entries = IDS.map((id) => {
    const st = settings[id];
    const geometry =
      id === '151' ? 'PACK_151_GEOMETRY' : JSON.stringify(st.geometry);
    const material =
      st.material === null
        ? `{ source: 'model-defaults' }`
        : JSON.stringify({
            source: st.material.source,
            foil: st.material.foil,
            relief: st.material.relief,
          });
    const note =
      st.material === null
        ? `// The approved render passed no foil, relief or alphaInterior: createPackModel's\n    // PACK_FOIL / PACK_RELIEF (alphaInterior ${'0.98'}). Front interior alpha ${st.frontInteriorAlpha}.\n    `
        : `// ${path.basename(st.material.source)}; both faces. Front interior alpha ${st.frontInteriorAlpha}.\n    `;
    return `${JSON.stringify(id)}: {\n    // geometry: ${st.geometrySource}\n    geometry: ${geometry},\n    // backGeometry: ${st.backSource}\n    backGeometry: ${JSON.stringify(st.backGeometry)},\n    // ink: what the approved render recorded (${st.inkSource})\n    ink: ${JSON.stringify(st.ink)},\n    ${note}material: ${material},\n  }`;
  });
  const s =
    header(
      "Each bundled pack's settings, as the approved 3D renders used them: the\n// sleeve geometry for createPackModel, the back's print zones for\n// packPrintSpecFromGeometry, the live text's ink, and the material.",
    ) +
    `\nimport { PACK_151_GEOMETRY } from '../pack-151';\nimport type { Pack3dSettings } from './pack-3d-types';\n\n` +
    `export const PACK_3D_SETTINGS: Readonly<Record<string, Pack3dSettings>> = {\n  ${entries.join(',\n  ')},\n};\n`;
  fs.writeFileSync(
    path.join(CATALOG, 'pack-3d-settings.ts'),
    await prettier.format(s, cfg),
  );
}

(async () => {
  const inks = inkUsed();
  const measures = {
    raw: readJson(path.join(LT, 'raw-packs', 'measure.json')),
    graded: readJson(path.join(LT, 'graded-packs', 'measure.json')),
  };
  const settings = {};
  const pictures = {};
  const proof = { step: STEP, pale: PALE, packs: {} };
  const ms = {};
  for (const id of IDS) {
    const s = src(id);
    const backJson = readJson(s.back);
    const mat = s.material ? readJson(s.material) : null;
    settings[id] = {
      geometry: s.pack ? packGeometry(readJson(s.pack)) : null,
      geometrySource: s.pack
        ? path.relative(repo, s.pack).replace(/\\/g, '/')
        : 'PACK_151_GEOMETRY (src/components/pack-3d/pack-151.ts)',
      backGeometry: backGeometry(backJson),
      backSource: path.relative(repo, s.back).replace(/\\/g, '/'),
      ink: inks[id],
      inkSource: `docs/research/home-3d/pack-3d/live-text/${RAW.includes(id) ? 'raw' : 'graded'}-packs/report.json`,
      material: mat
        ? {
            source: path.relative(repo, s.material).replace(/\\/g, '/'),
            foil: mat.foil,
            relief: mat.relief,
          }
        : null,
    };
    if (!MODULES_ONLY) {
      const r = await encodePictures(id, inks[id], backJson, measures);
      proof.packs[id] = r.proof;
      ms[id] = r;
      console.log(
        id,
        JSON.stringify(r.proof.bytes),
        'max diff',
        r.proof.back.maxChannelDiffVisible,
        'alpha',
        r.proof.back.alphaDiffPx,
        'ink same',
        r.proof.ink.identical,
      );
    }
    const dir = path.join(PUBLIC, id);
    const meta = async (name) =>
      sharp(path.join(dir, `${name}.webp`)).metadata();
    const [f, b, fh, bh] = await Promise.all(
      ['front', 'back', 'front-half', 'back-half'].map(meta),
    );
    check(
      f.width === b.width &&
        f.height === b.height &&
        fh.width === bh.width &&
        fh.height === bh.height,
      `${id}: front/back sizes differ`,
    );
    pictures[id] = {
      size: { width: f.width, height: f.height },
      half: { width: fh.width, height: fh.height },
      hash: Object.fromEntries(
        ['front', 'back', 'front-half', 'back-half'].map((n) => [
          n,
          sha8(fs.readFileSync(path.join(dir, `${n}.webp`))),
        ]),
      ),
    };
    settings[id].frontInteriorAlpha = interiorAlpha(
      await rgba(path.join(dir, 'front.webp')),
    );
  }

  if (!MODULES_ONLY) {
    // softness: measure-raw.cjs's match, redone with each heading edge measured
    // on the PNG and on the decoded WebP (the price-edge curve is the sweep's,
    // drawn by the canvas and independent of the plate's encoding)
    for (const [family, ids] of [
      ['raw', RAW],
      ['graded', GRADED],
    ]) {
      const mj = measures[family];
      const p151 = mj['151'].edge.priceBySoftness['0.35'];
      const r151png = p151 / ms['151'].mPng.headingEdge;
      const r151webp = p151 / ms['151'].mWebp.headingEdge;
      for (const id of ids) {
        const curve = mj[id].edge.priceBySoftness;
        const png = matchSoftness(curve, ms[id].mPng.headingEdge, r151png);
        const webp = matchSoftness(curve, ms[id].mWebp.headingEdge, r151webp);
        // platinum has no match in the sweep's range: compare the edge ratio at
        // the softness it uses instead
        const atUsed = (edge, r151) => {
          const pts = Object.entries(curve)
            .map(([s, w]) => [Number(s), w])
            .sort((a, b) => a[0] - b[0]);
          const s = inks[id].softness;
          for (let i = 1; i < pts.length; i++)
            if (pts[i - 1][0] <= s && s <= pts[i][0]) {
              const w =
                pts[i - 1][1] +
                ((s - pts[i - 1][0]) * (pts[i][1] - pts[i - 1][1])) /
                  (pts[i][0] - pts[i - 1][0]);
              return w / edge / r151;
            }
          return null;
        };
        const soft = {
          table: inks[id].softness,
          matchPng: png,
          matchWebp: webp,
          edgeRatioVs151AtTable: {
            png: atUsed(ms[id].mPng.headingEdge, r151png),
            webp: atUsed(ms[id].mWebp.headingEdge, r151webp),
          },
        };
        proof.packs[id].softness = soft;
        if (png !== null || webp !== null)
          check(
            png !== null &&
              webp !== null &&
              Math.abs(webp - png) <= 0.02 &&
              Math.abs(webp - inks[id].softness) <= 0.02,
            `${id}: matched softness moved ${png} -> ${webp}`,
          );
        // platinum: its 0.25 is a floor (no softness in the sweep matches), so
        // there is no matched value to hold within 0.02; its edge ratio at
        // 0.25 is reported in the proof instead
        console.log(id, 'softness', JSON.stringify(soft));
      }
    }
    const sum = (k) => IDS.reduce((a, id) => a + proof.packs[id].bytes[k], 0);
    proof.totals = {
      front: sum('front'),
      back: sum('back'),
      frontHalf: sum('frontHalf'),
      backHalf: sum('backHalf'),
    };
    proof.totals.all =
      proof.totals.front +
      proof.totals.back +
      proof.totals.frontHalf +
      proof.totals.backHalf;
    proof.totals.backAverage = Math.round(proof.totals.back / IDS.length);
    proof.totals.backLosslessAverage = Math.round(
      IDS.reduce((a, id) => a + proof.packs[id].back.losslessBytes, 0) /
        IDS.length,
    );
    proof.failures = failures;
    fs.mkdirSync(path.dirname(PROOF), { recursive: true });
    fs.writeFileSync(PROOF, JSON.stringify(proof, null, 1));
    console.log('totals', JSON.stringify(proof.totals));
  }
  await writeModules(settings, pictures);
  if (failures.length) {
    console.error('FAILED:\n' + failures.join('\n'));
    process.exit(1);
  }
  console.log('ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
