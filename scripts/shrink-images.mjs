// One-off: re-encode oversized browser-served images in public/.
//
// A handful of assets are outliers against their own neighbours — e.g.
// cdn/cards/h-027.webp is 716KB while the rest of that directory sits near
// 110KB at the same dimensions. Same dimensions, worse encoder settings. This
// re-encodes at a fixed quality and keeps the result only when it actually
// shrinks, so a well-compressed file is left exactly as it is.
//
// Dimensions are always preserved. Downscaling is a separate, per-asset
// judgement (it depends on the render size) and is deliberately not done here.
//
// WebP/JPEG output is LOSSY (quality 80) — verified acceptable for this repo's
// art by checking that the alpha channel comes through bit-identical, which is
// what protects the card cutouts from the halo/fringe artefacts documented in
// the debugging-slab-visuals skill. PNG output is lossless (see PNG_OPTS).
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
 * Lossless PNG. `palette: false` is load-bearing, not decoration: sharp infers
 * `palette: true` from the mere presence of `quality`/`effort`/`colours`/
 * `dither`, which silently swaps in libimagequant 256-colour quantisation —
 * lossy, and prone to banding on gradients. Because quantisation always wins on
 * size, the MIN_GAIN gate below would happily accept the degraded result. PNG
 * here is only ever a re-compress, so state the truecolour intent explicitly.
 */
const PNG_OPTS = { compressionLevel: 9, palette: false };

/**
 * Assets under public/ that are INPUTS TO A GENERATOR rather than (only)
 * browser-served output. Re-encoding these degrades everything produced from
 * them later, so they are left byte-for-byte alone.
 *
 * Note the rule is "consumed by a generator", not "never requested by a
 * browser" — public/cdn/cards/h-*.webp are BOTH: bake-slab.ts fetches them to
 * composite card.slab_image. Those stay in scope only because this pass keeps
 * alpha bit-identical and sharp premultiplies on resize, so the baked slabs are
 * unaffected. A less careful encoder setting would need them listed here too.
 */
const MASTERS = new Set([
  // -> public/seo/icon-{192,512}.png, src/app/{icon,apple-icon}.png
  //    (scripts/rebrand-polycards-logo.mjs)
  'public/branding/polycards-icon.png',
  // -> backend .../media/slab-frame-default.ts, scripts/compose-frame-variant.mjs
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
  // Kept beside the source on purpose: a cross-device rename out of os.tmpdir()
  // fails on Windows, which is the platform this runs on. The `finally` below
  // is what keeps a crashed run from leaving this stray inside public/, where
  // `git add -A` would commit it and the deploy would then serve it.
  const tmp = `${file}.tmp${ext}`;

  try {
    // Re-encode at the SAME dimensions — an encoder-settings fix, not a resize.
    // `effort: 6` trades build time for a smaller file (one-off script).
    // Decode from a Buffer, not the path: libvips keeps a lazy handle on a file
    // input, and on Windows that open handle makes the rename-over-source below
    // fail with EPERM.
    const img = sharp(await readFile(file));
    await (
      ext === '.webp'
        ? img.webp({ quality: QUALITY, effort: 6 })
        : ext === '.png'
          ? img.png(PNG_OPTS)
          : img.jpeg({ quality: QUALITY, mozjpeg: true })
    ).toFile(tmp);

    const out = (await stat(tmp)).size;
    const gain = 1 - out / size;

    if (dry || gain < MIN_GAIN) {
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
  } finally {
    // No-op once the rename succeeded; the point is the paths that did not.
    await unlink(tmp).catch(() => {});
  }
}

console.log(
  `\n${changed} re-encoded — ${kb(before)}KB -> ${kb(after)}KB (-${Math.round((1 - after / before) * 100)}%)`,
);
