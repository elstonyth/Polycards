// One-off: re-encode the autoplaying hero/factory loops from 1080p to 720p.
//
// These clips autoplay (AmbientVideo sets autoPlay + loop), so `preload="metadata"`
// buys nothing once playback starts — the browser pulls the whole file on every
// visit to `/` (shop-night) and `/slots/[slug]` (per-tier factory). At 1920x1080
// they were 0.9–3.8 MB each for a panel that renders at ~60vw.
//
// Rates were picked by measuring, not guessing: at 1280x720 VP9 CRF 42 lands
// under h264 CRF 26 for this content (flat dark backdrop, slow camera), and a
// frame-vs-frame read at CRF 42 is indistinguishable from the 1080p source.
//
//   node scripts/shrink-videos.mjs [--dry]
import { execFile } from 'node:child_process';
import { readdir, stat, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const dry = process.argv.includes('--dry');

/** Panel-sized, not screen-sized: 1280 covers a 60vw hero to ~2133px wide. */
const WIDTH = 1280;
/**
 * Downscale only, never up. `scale=W:-2` alone would stretch a portrait or
 * square source (720x1280 is over the height gate but under WIDTH), so cap the
 * target at the source width. -2 keeps the aspect and forces an even height,
 * which yuv420p requires.
 */
const SCALE = `scale='min(${WIDTH},iw)':-2`;

const DIRS = ['public/images/polycards', 'public/videos'];

/** Encoder args per container. `-an` because every one of these clips is silent. */
const ENCODERS = {
  '.mp4': [
    '-c:v',
    'libx264',
    '-crf',
    '26',
    '-preset',
    'slow',
    '-pix_fmt',
    'yuv420p',
    '-an',
    '-movflags',
    '+faststart',
  ],
  '.webm': [
    '-c:v',
    'libvpx-vp9',
    '-crf',
    '42',
    '-b:v',
    '0',
    '-row-mt',
    '1',
    '-an',
  ],
};

const kb = (n) => Math.round(n / 1024);

/** Source height, so already-720p files are skipped instead of re-encoded. */
async function height(file) {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=height',
    '-of',
    'csv=p=0',
    file,
  ]);
  const h = Number.parseInt(stdout.trim(), 10);
  // A container with no video stream (or a multi-stream oddity) yields NaN, and
  // `NaN <= 720` is false — so without this the file would fall through to a
  // pointless encode instead of being skipped.
  return Number.isFinite(h) ? h : null;
}

let before = 0;
let after = 0;

for (const dir of DIRS) {
  // A pruned directory should skip the pass, not abort it mid-run.
  const entries = await readdir(dir).catch(() => []);
  for (const name of entries) {
    const ext = name.slice(name.lastIndexOf('.'));
    const args = ENCODERS[ext];
    if (!args) continue;

    const file = join(dir, name);
    const h = await height(file);
    if (h === null) {
      console.log(`skip  ${file} (no readable video stream)`);
      continue;
    }
    if (h <= 720) {
      console.log(`skip  ${file} (already ${h}p)`);
      continue;
    }

    const size = (await stat(file)).size;
    before += size;

    if (dry) {
      console.log(`would ${file} ${h}p ${kb(size)}KB`);
      after += size;
      continue;
    }

    // Encode beside the original, then swap — a crashed ffmpeg leaves the
    // original intact rather than a truncated file the storefront would serve.
    // Beside, not in os.tmpdir(): a cross-device rename fails on Windows. The
    // `finally` is what stops a crash from leaving the stray inside public/,
    // where `git add -A` would commit it and the deploy would serve it.
    const tmp = `${file}.tmp${ext}`;
    try {
      await run('ffmpeg', [
        '-y',
        '-loglevel',
        'error',
        '-i',
        file,
        '-vf',
        SCALE,
        ...args,
        tmp,
      ]);
      const out = (await stat(tmp)).size;

      if (out >= size) {
        // Re-encoding made it bigger (already well-compressed). Keep the original.
        console.log(`keep  ${file} ${kb(size)}KB (re-encode was ${kb(out)}KB)`);
        after += size;
        continue;
      }

      await rename(tmp, file);
      after += out;
      const pct = Math.round((1 - out / size) * 100);
      console.log(
        `ok    ${file} ${h}p ${kb(size)}KB -> 720p ${kb(out)}KB (-${pct}%)`,
      );
    } finally {
      // No-op once the rename succeeded; the point is the paths that did not.
      await unlink(tmp).catch(() => {});
    }
  }
}

console.log(
  before === 0
    ? '\nnothing to do — every clip is already at target'
    : `\ntotal ${kb(before)}KB -> ${kb(after)}KB (-${Math.round((1 - after / before) * 100)}%)`,
);
