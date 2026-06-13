// Crop the display-stand pedestal (and its watermark) off every card asset in
// public/cdn/cards/, leaving the graded slab only — the new content convention:
// admins upload slab-only card images, and live's reveal uses "-cropped" slab-only
// variants too. Originals stay in git history.
//
// Detection: the photos share one template (512x512, near-black bg, bright slab
// centered in the upper ~75%, dark gap, bright metallic pedestal at the bottom).
// Per row/column, take a high-percentile luminance inside the central band; the
// slab is the FIRST sustained bright block from the top — crop to its bbox + pad,
// which naturally excludes the pedestal below the dark gap.
//
// Run: node scripts/crop-card-pedestals.mjs [--dry]
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';

const DIR = path.resolve('public/cdn/cards');
const DRY = process.argv.includes('--dry');
const PAD = 8;
const BRIGHT = 30; // 0-255 luminance: above = slab/pedestal, below = background
const RUN = 6; // sustained rows to confirm a block edge

const p95 = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
};

async function cropOne(file) {
  const buf = fs.readFileSync(file);
  const img = sharp(buf);
  const { width: W, height: H } = await img.metadata();
  const gray = await img.clone().greyscale().raw().toBuffer();

  // row profile within the central x-band (slab + pedestal both live there)
  const x0 = Math.floor(W * 0.3),
    x1 = Math.ceil(W * 0.7);
  const rowVal = new Array(H);
  for (let y = 0; y < H; y++) {
    const band = [];
    for (let x = x0; x < x1; x += 2) band.push(gray[y * W + x]);
    rowVal[y] = p95(band);
  }
  // slab top: first row of a sustained bright run from the top
  let top = -1;
  for (let y = 0, run = 0; y < H; y++) {
    run = rowVal[y] > BRIGHT ? run + 1 : 0;
    if (run >= RUN) {
      top = y - RUN + 1;
      break;
    }
  }
  // slab bottom: from slab middle downward, first sustained DARK run = the gap
  let bottom = -1;
  const mid = Math.floor((top + H * 0.75) / 2);
  for (let y = mid, run = 0; y < H; y++) {
    run = rowVal[y] <= BRIGHT ? run + 1 : 0;
    if (run >= RUN) {
      bottom = y - RUN;
      break;
    }
  }
  // No dark gap below the slab = no pedestal (already a slab-only scan, e.g. on
  // a white background) — leave the file untouched.
  if (bottom < 0)
    return {
      file: path.basename(file),
      skip: 'already slab-only (no pedestal gap)',
    };
  if (top < 0 || bottom <= top)
    return { file, error: `no slab block (top=${top} bottom=${bottom})` };

  // column profile within the slab's y-range
  const colVal = new Array(W);
  for (let x = 0; x < W; x++) {
    const band = [];
    for (let y = top; y < bottom; y += 2) band.push(gray[y * W + x]);
    colVal[x] = p95(band);
  }
  let left = -1,
    right = -1;
  for (let x = 0, run = 0; x < W; x++) {
    run = colVal[x] > BRIGHT ? run + 1 : 0;
    if (run >= RUN) {
      left = x - RUN + 1;
      break;
    }
  }
  for (let x = W - 1, run = 0; x >= 0; x--) {
    run = colVal[x] > BRIGHT ? run + 1 : 0;
    if (run >= RUN) {
      right = x + RUN - 1;
      break;
    }
  }
  if (left < 0 || right <= left) return { file, error: 'no slab columns' };

  const box = {
    left: Math.max(0, left - PAD),
    top: Math.max(0, top - PAD),
    width: Math.min(W, right + PAD) - Math.max(0, left - PAD),
    height: Math.min(H, bottom + PAD) - Math.max(0, top - PAD),
  };
  // box ≈ the full frame -> nothing to remove
  if (box.width > W * 0.95 && box.height > H * 0.95) {
    return {
      file: path.basename(file),
      skip: 'already slab-only (full-frame box)',
    };
  }
  const ratio = box.height / box.width;
  if (!DRY) {
    const out = await sharp(buf).extract(box).webp({ quality: 92 }).toBuffer();
    fs.writeFileSync(file, out);
  }
  return {
    file: path.basename(file),
    box: `${box.width}x${box.height}@${box.left},${box.top}`,
    ratio: +ratio.toFixed(2),
  };
}

const files = fs
  .readdirSync(DIR)
  .filter((f) => f.endsWith('.webp'))
  .map((f) => path.join(DIR, f));
let errors = 0,
  outliers = 0,
  skipped = 0;
for (const f of files) {
  const r = await cropOne(f);
  if (r.error) {
    console.log(`ERROR  ${path.basename(f)}: ${r.error}`);
    errors++;
    continue;
  }
  if (r.skip) {
    console.log(`skip   ${r.file}  (${r.skip})`);
    skipped++;
    continue;
  }
  // a graded slab is ~1.4-1.8 tall:wide — flag anything else for eyeballing
  const flag =
    r.ratio < 1.3 || r.ratio > 1.95 ? '  <-- RATIO OUTLIER, inspect' : '';
  if (flag) outliers++;
  console.log(
    `${DRY ? 'would crop' : 'cropped'}  ${r.file}  -> ${r.box}  ratio ${r.ratio}${flag}`,
  );
}
console.log(
  `\n${files.length} files, ${skipped} skipped (already slab-only), ${errors} errors, ${outliers} ratio outliers${DRY ? ' (dry run)' : ''}`,
);
process.exit(errors ? 1 : 0);
