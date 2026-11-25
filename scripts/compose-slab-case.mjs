// The graded slab's case, front and back, from one Blender model of a clear
// plastic holder (scripts/render-slab-case.py, owner 2026-11-24).
//
//   blender -b --factory-startup -P scripts/render-slab-case.py
//     -> docs/research/slab-case/black.png, white.png
//   node scripts/compose-slab-case.mjs label
//     -> docs/research/slab-case/label-mask.png        the back label's relief
//   blender -b --factory-startup -P scripts/render-card-back.py -- --size 1363x392
//     --mask docs/research/slab-case/label-mask.png --out docs/research/slab-case/label.png
//   node scripts/compose-slab-case.mjs
//     -> public/images/slab-frame.webp                 the front: a see-through
//        frame the backend bakes each graded card under (bake-slab.ts)
//     -> public/images/app/polycards-slab-back.webp    the back: the card back
//        and the Polycards label inside the same case. See-through like the
//        front, so both faces show the same stage through the plastic.
//   node scripts/gen-slab-frame-module.mjs
//     -> the backend's bundled copy of the front frame
//   blender -b --factory-startup -P scripts/render-slab-case.py -- --edge
//   node scripts/compose-slab-case.mjs edges
//     -> public/images/app/slab-edge-v.webp   the case seen edge-on: what
//        shows between the two faces when the reveal turns it
//
// A changed front frame only reaches graded cards already on the site once
// they are re-baked (backend src/scripts/bake-slab-images.ts).
//
// One picture this needs is not in the tree (docs/research is gitignored):
//   git show 1bbd87e7c:public/images/slab-frame.webp
//     -> docs/research/slab-case/slab-frame-old.webp   for the PSA label sticker
import { readFileSync } from 'node:fs';
import sharp from 'sharp';

const DIR = 'docs/research/slab-case';
const W = 1600;
const H = 2700;

// Measured on the old frame: the sticker's box. Its outer few px are a soft
// pink edge into the old white plastic, so the sticker is taken a little
// inside the box, with rounded corners.
const LABEL = { x0: 117, x1: 1489, y0: 113, y1: 514 };
const STICKER_INSET = 5;
const STICKER_R = 8;
// The card well of the model (render-slab-case.py WIN), 4px inside its edge:
// the rounded edge of the plastic fades out over the first 3px.
const WELL = { x0: 178, x1: 1422, y0: 734, y1: 2496 };
const WELL_R = 10; // its corners are round (14 in the model)
// Where backend bake-slab.ts puts a 5:7 card (SLAB_WINDOW, 8px recess).
const CARD = { x0: 183, x1: 1417, y0: 739, y1: 2468 };

// Distance outside a rounded box: <= 0 inside.
const outside = (b, r, x, y) => {
  const qx = Math.abs(x - (b.x0 + b.x1) / 2) - ((b.x1 - b.x0) / 2 - r);
  const qy = Math.abs(y - (b.y0 + b.y1) / 2) - ((b.y1 - b.y0) / 2 - r);
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
    Math.min(Math.max(qx, qy), 0) -
    r
  );
};
const STICKER = {
  x0: LABEL.x0 + STICKER_INSET,
  x1: LABEL.x1 - STICKER_INSET,
  y0: LABEL.y0 + STICKER_INSET,
  y1: LABEL.y1 - STICKER_INSET,
};
const inSticker = (x, y) => outside(STICKER, STICKER_R, x, y) <= 0;
const sw = STICKER.x1 - STICKER.x0 + 1;
const sh = STICKER.y1 - STICKER.y0 + 1;

// The back label (owner 2026-11-24): the card back's matte black stock with
// "Polycards" raised in white, small and centred. No mark: the card under it
// carries the mark. Round it, a border pressed in without ink where the front
// label's red border is, so it reads as the same label seen from behind. No QR
// code: at these sizes none would scan.
if (process.argv[2] === 'label') {
  const WORD_W = 480; // the wordmark across the label
  const BLIND = 0.26; // the border's height: under the ink line (0.3), relief only
  // The front label's white panel starts 38px in from the sides, 42 from the
  // top and 33 from the bottom of the sticker.
  const panel = { x: 38, y: 42, w: sw - 76, h: sh - 75, r: 6 };
  const src = readFileSync(
    'src/components/brand/polycards-logo-paths.ts',
    'utf8',
  );
  const letters = [...src.matchAll(/\bd: '([^']+)'/g)].map((m) => m[1]);
  if (letters.length !== 9)
    throw new Error(`expected 9 letters, got ${letters.length}`);
  // The wordmark's box in the logo's 360x97 units: cap top to baseline, so the
  // y's tail hangs below the centre line as it does in the logo.
  const L = { x: 99.25, y: 29.53, w: 260.69, h: 72.33 - 29.53 };
  const s = WORD_W / L.w;
  const g = Math.round(BLIND * 255);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${sw}' height='${sh}'>` +
    `<rect width='100%' height='100%' fill='rgb(${g},${g},${g})'/>` +
    `<rect x='${panel.x}' y='${panel.y}' width='${panel.w}' height='${panel.h}' rx='${panel.r}' fill='black'/>` +
    `<g fill='white' transform='translate(${(sw - L.w * s) / 2} ${(sh - L.h * s) / 2}) scale(${s}) translate(${-L.x} ${-L.y})'>` +
    letters.map((d) => `<path d='${d}'/>`).join('') +
    `</g></svg>`;
  await sharp(Buffer.from(svg))
    .blur(1.6)
    .greyscale()
    .png()
    .toFile(`${DIR}/label-mask.png`);
  console.log(`done: ${DIR}/label-mask.png (${sw}x${sh})`);
  process.exit(0);
}

// The case's long edge, for the pack reveal's 3D turn (SlabCard.tsx). The
// render is over black, so the strip is white light: as solid as the render is
// bright, over a faint haze so the edge reads as plastic where it is dark (a
// dark body looked like a gap between the faces). Only the long edge: the slab
// turns about its upright axis, and the short edges showed as stray lines at
// the corners.
if (process.argv[2] === 'edges') {
  const BODY = 0.3;
  const GAIN = 1.0;
  for (const [which, across] of [['v', 48]]) {
    const { data, info } = await sharp(`${DIR}/edge-${which}.png`)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const { width, height } = info;
    const lit = (x, y) => {
      const i = (y * width + x) * 3;
      return Math.max(data[i], data[i + 1], data[i + 2]);
    };
    // The case's box in the render: the first and last row and column with light.
    let x0 = width;
    let x1 = -1;
    let y0 = height;
    let y1 = -1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (lit(x, y) > 10) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const a = Math.min(1, BODY + (lit(x + x0, y + y0) / 255) * GAIN);
        const o = (y * w + x) * 4;
        out[o] = out[o + 1] = out[o + 2] = 255;
        out[o + 3] = Math.round(a * 255);
      }
    // Shown about 15px across, so 48 is plenty at 3x.
    const size =
      which === 'v'
        ? { width: across, height: Math.round((h * across) / w) }
        : { width: Math.round((w * across) / h), height: across };
    const file = `public/images/app/slab-edge-${which}.webp`;
    await sharp(out, { raw: { width: w, height: h, channels: 4 } })
      .resize({ ...size, fit: 'fill' })
      .webp({ quality: 86, alphaQuality: 90, effort: 6 })
      .toFile(file);
    console.log(`done: ${file} ${size.width}x${size.height} (case ${w}x${h})`);
  }
  process.exit(0);
}
// The model's outline: 8px in from the canvas, radius 60.
const OUTLINE = { x0: 8, x1: W - 8, y0: 8, y1: H - 8 };

const rgb = (file) =>
  sharp(file).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer();
const [black, white, old] = await Promise.all([
  rgb(`${DIR}/black.png`),
  rgb(`${DIR}/white.png`),
  sharp(`${DIR}/slab-frame-old.webp`).ensureAlpha().raw().toBuffer(),
]);
if (old.length !== W * H * 4)
  throw new Error('slab-frame-old.webp: expected 1600x2700');

// A pixel over a page of colour c shows black + (white - black) * c. So what
// the case adds is the black pass, and what it lets through is white - black.
const frame = Buffer.alloc(W * H * 4);
const plastic = Buffer.alloc(W * H * 4); // the same, without the sticker
let wellMax = 0;
let strayMax = 0;
const bins = new Array(8).fill(0);
let count = 0;
for (let p = 0; p < W * H; p++) {
  const x = p % W;
  const y = (p / W) | 0;
  if (inSticker(x, y)) {
    old.copy(frame, p * 4, p * 4, p * 4 + 3);
    frame[p * 4 + 3] = 255;
    continue;
  }
  const b = [black[p * 3], black[p * 3 + 1], black[p * 3 + 2]];
  const through =
    (white[p * 3] - b[0] + white[p * 3 + 1] - b[1] + white[p * 3 + 2] - b[2]) /
    3 /
    255;
  // Never less solid than its own highlight needs.
  let a = Math.round(
    255 * Math.max(1 - Math.min(1, Math.max(0, through)), Math.max(...b) / 255),
  );
  if (a < 4) a = 0;
  if (outside(WELL, WELL_R, x, y) <= 0) {
    wellMax = Math.max(wellMax, a);
    a = 0; // nothing over the card, whatever the render says
  } else if (outside(OUTLINE, 60, x, y) > 5) {
    strayMax = Math.max(strayMax, a);
    a = 0; // no case out here
  }
  if (a === 0) continue;
  for (let c = 0; c < 3; c++)
    frame[p * 4 + c] = Math.min(255, Math.round((b[c] * 255) / a));
  frame[p * 4 + 3] = a;
  frame.copy(plastic, p * 4, p * 4, p * 4 + 4);
  bins[a >> 5]++;
  count++;
}
// The render must already leave the card clear; a haze there means the model
// and WELL above have drifted apart.
if (wellMax > 8)
  throw new Error(`the render puts plastic over the card (alpha ${wellMax})`);
console.log(
  `cleared: over the card alpha max ${wellMax}, past the outline alpha max ${strayMax}`,
);
console.log(
  `plastic alpha, 32-wide bins: ${bins.map((v) => ((v / count) * 100).toFixed(0)).join(' ')} (clear plastic sits in the first three)`,
);

const raw = (buf) => ({
  raw: { width: W, height: H, channels: 4 },
  input: buf,
});
const front = 'public/images/slab-frame.webp';
await sharp(frame, { raw: { width: W, height: H, channels: 4 } })
  .webp({ quality: 92, alphaQuality: 100, effort: 6 })
  .toFile(front);

// The back: the Polycards label in the sticker's place, the card back where the
// card sits, the same plastic over both.
const rounded = (w, h, r) =>
  Buffer.from(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}'><rect width='${w}' height='${h}' rx='${r}' fill='white'/></svg>`,
  );
const backLabel = await sharp(`${DIR}/label.png`)
  .resize(sw, sh, { fit: 'fill' })
  .composite([{ input: rounded(sw, sh, STICKER_R), blend: 'dest-in' }])
  .png()
  .toBuffer();
const cw = CARD.x1 - CARD.x0 + 1;
const ch = CARD.y1 - CARD.y0 + 1;
const card = await sharp('public/images/app/polycards-card-back.webp')
  .resize(cw, ch, { fit: 'fill' })
  .composite([
    { input: rounded(cw, ch, Math.round(cw * 0.048)), blend: 'dest-in' },
  ])
  .png()
  .toBuffer();
const back = 'public/images/app/polycards-slab-back.webp';
const full = await sharp({
  create: {
    width: W,
    height: H,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite([
    { input: card, left: CARD.x0, top: CARD.y0 },
    { input: backLabel, left: STICKER.x0, top: STICKER.y0 },
    raw(plastic),
  ])
  .png()
  .toBuffer();
await sharp(full)
  .resize(900, 1519, { fit: 'fill' })
  .webp({ quality: 84, alphaQuality: 50, effort: 6 }) // a plain <img> on the reveal: keep it light
  .toFile(back);
console.log(
  `done: ${front}, ${back}. Now run: node scripts/gen-slab-frame-module.mjs`,
);
