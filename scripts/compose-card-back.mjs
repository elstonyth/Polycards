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
//
// The graded slab's back holds this same card inside its case; that picture is
// made by scripts/compose-slab-case.mjs, so re-run it after a new card back.
//
// The shipped picture is the card face only: 5:7, opaque, full-bleed, no baked
// corners or border. SlabImage rounds the corners and puts the tier band on.
import { mkdirSync, readFileSync } from 'node:fs';
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
} else {
  throw new Error('usage: compose-card-back.mjs mask|ship');
}
