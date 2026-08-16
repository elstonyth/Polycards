// One-off: re-encode oversized browser-served images in public/.
//
// A handful of assets are outliers against their own neighbours — e.g.
// cdn/cards/h-027.webp is 716KB while the rest of that directory sits near
// 110KB at the same dimensions. Same pixels, worse encoder settings. This
// re-encodes at a fixed quality and keeps the result only when it actually
// shrinks, so a well-compressed file is left exactly as it is.
//
// Dimensions are preserved. Downscaling is a separate, per-asset judgement
// (it depends on the render size) and is deliberately not done here.
//
//   node scripts/shrink-images.mjs [--dry]
import sharp from 'sharp';
import { stat, rename, unlink, readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';
import { extname } from 'node:path';

const dry = process.argv.includes('--dry');

/** Below this, the absolute saving is not worth a binary diff. */
const MIN_BYTES = 100 * 1024;
/** Keep the re-encode only if it saves at least this share of the original. */
const MIN_GAIN = 0.15;
const QUALITY = 80;

/**
 * Design masters that live under public/ but are never requested by a browser:
 * they are inputs to scripts/ (logo regeneration, slab composition) and to the
 * backend's base64 frame module. Re-encoding them would quietly degrade every
 * asset generated from them later.
 */
const MASTERS = new Set([
  'public/branding/polycards-icon.png',
  'public/images/slab-frame.webp',
]);

const kb = (n) => Math.round(n / 1024);

let before = 0;
let after = 0;
let changed = 0;

for await (const found of glob('public/**/*.{webp,png,jpg,jpeg}')) {
  const file = found.replaceAll('\\', '/');
  if (MASTERS.has(file)) continue;

  const size = (await stat(file)).size;
  if (size < MIN_BYTES) continue;

  before += size;
  const ext = extname(file).toLowerCase();
  const tmp = `${file}.tmp${ext}`;

  // Re-encode at the SAME dimensions — this is an encoder-settings fix, not a
  // resize. `effort: 6` trades build time for a smaller file (one-off script).
  // Decode from a Buffer, not the path: libvips keeps a lazy handle on a file
  // input, and on Windows that open handle makes the rename-over-source below
  // fail with EPERM.
  const img = sharp(await readFile(file));
  await (
    ext === '.webp'
      ? img.webp({ quality: QUALITY, effort: 6 })
      : ext === '.png'
        ? img.png({ compressionLevel: 9, effort: 10 })
        : img.jpeg({ quality: QUALITY, mozjpeg: true })
  ).toFile(tmp);

  const out = (await stat(tmp)).size;
  const gain = 1 - out / size;

  if (dry || gain < MIN_GAIN) {
    await unlink(tmp);
    after += size;
    if (dry && gain >= MIN_GAIN) {
      console.log(
        `would ${file} ${kb(size)}KB -> ${kb(out)}KB (-${Math.round(gain * 100)}%)`,
      );
    }
    continue;
  }

  await rename(tmp, file);
  after += out;
  changed += 1;
  console.log(
    `ok    ${file} ${kb(size)}KB -> ${kb(out)}KB (-${Math.round(gain * 100)}%)`,
  );
}

console.log(
  `\n${changed} re-encoded — ${kb(before)}KB -> ${kb(after)}KB (-${Math.round((1 - after / before) * 100)}%)`,
);
