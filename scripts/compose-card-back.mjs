// The raw card back ("Raised mark", owner 2026-11-24): a plain matte black
// card with the Polycards mark and wordmark raised from it in white. Two steps
// round one Blender render (scripts/render-card-back.py):
//
//   node scripts/compose-card-back.mjs mask
//     -> docs/research/card-back/mask.png   the logo as a height map
//   blender -b --factory-startup -P scripts/render-card-back.py
//     -> docs/research/card-back/render.png
//   node scripts/compose-card-back.mjs ship
//     -> public/images/app/polycards-card-back.webp
//     -> public/images/app/polycards-slab-back.webp   the same card inside the
//        acrylic case, for graded pulls (see slabBack below)
//
// The shipped picture is the card face only: 5:7, opaque, full-bleed, no baked
// corners or border. SlabImage rounds the corners and puts the tier band on.
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import sharp from 'sharp';

const DIR = 'docs/research/card-back';
const W = 1200;
const H = 1680;

// Layout, as fractions of the card width: the picked concept's own sizes (mark
// 18%, wordmark 28%). A larger mark (23% / 34%) was refused: he wants it small.
const MARK_W = 0.18;
const WORD_W = 0.28;
const GAP = 0.04; // mark bottom to the top of the tall letters
const CENTRE_Y = 0.49; // of the card height: the block sits a touch above middle

/**
 * The slab back (a graded pull, face-down): the SAME card, seen inside the
 * acrylic case (owner 2026-11-24: "graded should be changed as well, they both
 * the same thing"). The case is the old slab-back picture, which had a flat
 * monogram card baked in; the new card is laid over that card's exact place,
 * and the soft light the acrylic threw across the old card is put back on top
 * so it still sits behind the plastic.
 *
 * Needs the old picture as docs/research/card-back/slab-case.webp:
 *   git show 517200c6f:public/images/app/polycards-slab-back.webp
 */
async function slabBack() {
  const CASE = `${DIR}/slab-case.webp`; // 900x1519
  if (!existsSync(CASE)) {
    console.log(`skipped the slab back: ${CASE} is missing (see slabBack)`);
    return;
  }
  // Measured on the old picture: the card's box, and its monogram (+ margin).
  const R = { x: 99, y: 393, w: 703, h: 1007, r: 23 };
  const LOGO = { x0: 201, x1: 506, y0: 282, y1: 722 }; // inside R

  // 1. The acrylic's light on the old card: the old card with its monogram
  // bridged over (each column fades from the row above it to the row below),
  // then blurred until only the broad light is left.
  const old = await sharp(CASE)
    .extract({ left: R.x, top: R.y, width: R.w, height: R.h })
    .greyscale()
    .raw()
    .toBuffer();
  for (let x = LOGO.x0; x <= LOGO.x1; x++) {
    const a = old[(LOGO.y0 - 1) * R.w + x];
    const b = old[(LOGO.y1 + 1) * R.w + x];
    for (let y = LOGO.y0; y <= LOGO.y1; y++) {
      const t = (y - LOGO.y0) / (LOGO.y1 - LOGO.y0);
      old[y * R.w + x] = a + (b - a) * t;
    }
  }
  const light = await sharp(old, {
    raw: { width: R.w, height: R.h, channels: 1 },
  })
    .blur(22)
    .toColourspace('b-w') // or sharp hands back three channels
    .raw()
    .toBuffer();
  if (old.length !== R.w * R.h || light.length !== R.w * R.h)
    throw new Error('slab back: expected one channel per pixel');

  // 2. The new card in that box, with the light screened back on. Tuned so the
  // new card comes out as bright as the old one was at its top, middle and
  // bottom (about 78, 40 and 22 of 255); the render alone is darker low down
  // and its bottom edge sank into the case.
  const HAZE_FLOOR = 22;
  const HAZE_GAIN = 0.7;
  const card = await sharp(`${DIR}/render.png`)
    .resize(R.w, R.h, { fit: 'cover' })
    .removeAlpha()
    .raw()
    .toBuffer();
  for (let i = 0; i < R.w * R.h; i++) {
    const haze = Math.max(0, light[i] - HAZE_FLOOR) * HAZE_GAIN;
    for (let c = 0; c < 3; c++) {
      const v = card[i * 3 + c];
      card[i * 3 + c] = 255 - ((255 - v) * (255 - haze)) / 255;
    }
  }
  const corners = Buffer.from(
    `<svg xmlns='http://www.w3.org/2000/svg' width='${R.w}' height='${R.h}'><rect width='${R.w}' height='${R.h}' rx='${R.r}' fill='white'/></svg>`,
  );
  const cut = await sharp(card, {
    raw: { width: R.w, height: R.h, channels: 3 },
  })
    .ensureAlpha()
    .composite([{ input: corners, blend: 'dest-in' }])
    .png()
    .toBuffer();

  // 3. Back into the case.
  const out = 'public/images/app/polycards-slab-back.webp';
  await sharp(CASE)
    .composite([{ input: cut, left: R.x, top: R.y }])
    .webp({ quality: 90 })
    .toFile(out);
  console.log(`done: ${out}`);
}

const step = process.argv[2];
if (step === 'mask') {
  // The logo's vector paths, read as text: this file is plain node, not TS.
  const src = readFileSync(
    'src/components/brand/polycards-logo-paths.ts',
    'utf8',
  );
  const mark = src.match(/LOGO_MARK =\s*'([^']+)'/)[1];
  const stroke = Number(src.match(/width: ([\d.]+)/)[1]);
  const letters = [...src.matchAll(/\bd: '([^']+)'/g)].map((m) => m[1]);
  if (letters.length !== 9)
    throw new Error(`expected 9 letters, got ${letters.length}`);

  // Ink boxes in the logo's own 360x97 units (mark edges include half a stroke).
  const M = {
    x: 2.28 - stroke / 2,
    y: 9.07 - stroke / 2,
    w: 49.7 + stroke,
    h: 70.93 + stroke,
  };
  const L = { x: 99.25, y: 29.53, w: 260.69, base: 72.33 };
  const sm = (MARK_W * W) / M.w;
  const sl = (WORD_W * W) / L.w;
  const block = M.h * sm + GAP * W + (L.base - L.y) * sl; // mark top to baseline
  const top = CENTRE_Y * H - block / 2;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}'>` +
    `<rect width='100%' height='100%' fill='black'/>` +
    `<g transform='translate(${(W - M.w * sm) / 2} ${top}) scale(${sm}) translate(${-M.x} ${-M.y})'>` +
    `<path d='${mark}' fill='none' stroke='white' stroke-width='${stroke}' stroke-linejoin='round'/></g>` +
    `<g fill='white' transform='translate(${(W - L.w * sl) / 2} ${top + M.h * sm + GAP * W}) scale(${sl}) translate(${-L.x} ${-L.y})'>` +
    letters.map((d) => `<path d='${d}'/>`).join('') +
    `</g></svg>`;
  mkdirSync(DIR, { recursive: true });
  // A slight blur rounds the shoulders of the raised mark.
  await sharp(Buffer.from(svg))
    .blur(1.6)
    .greyscale()
    .png()
    .toFile(`${DIR}/mask.png`);
  console.log(`done: ${DIR}/mask.png`);
} else if (step === 'ship') {
  const out = 'public/images/app/polycards-card-back.webp';
  await sharp(`${DIR}/render.png`)
    .resize(W, H, { fit: 'fill' })
    .removeAlpha()
    .webp({ quality: 90 })
    .toFile(out);
  console.log(`done: ${out}`);
  await slabBack();
} else {
  throw new Error('usage: compose-card-back.mjs mask|ship');
}
