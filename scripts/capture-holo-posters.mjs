// Saves the poster picture of each live 3D icon (src/components/holo-3d): the
// still shown before the 3D loads, and in its place for reduced motion or no
// WebGL. It reads the icons' own canvases off /holo-preview, so a poster is
// the exact first frame of the live icon.
//
//   node scripts/capture-holo-posters.mjs [base] [name...]
//   (base defaults to http://127.0.0.1:4330; names, e.g. crown-gold, limit
//   which posters are written, so the others keep their committed frame)
//
// Needs a server with the preview switch on (next dev, or HOME_PREVIEW=1) and
// ffmpeg on PATH. Writes public/3dicons/<name>.webp for each `data-poster`
// box on the page.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const base = process.argv[2] ?? 'http://127.0.0.1:4330';
const out = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'public',
  '3dicons',
);
const only = process.argv.slice(3);

const browser = await chromium.launch({ args: ['--mute-audio'] });
try {
  const ctx = await browser.newContext({
    viewport: { width: 1100, height: 900 },
    deviceScaleFactor: 2,
  });
  await ctx.addInitScript(() => {
    // Without this a WebGL canvas reads back empty once its frame is shown.
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, options) {
      return original.call(this, type, {
        ...options,
        preserveDrawingBuffer: true,
      });
    };
  });
  const page = await ctx.newPage();
  await page.goto(`${base}/holo-preview`, {
    waitUntil: 'load',
    timeout: 180_000,
  });
  const shots = await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const started = performance.now();
        const tick = () => {
          const boxes = [...document.querySelectorAll('[data-poster]')];
          const canvases = boxes.map((b) => b.querySelector('canvas'));
          const live = canvases.every(
            (c) => c && Number(getComputedStyle(c).opacity) > 0,
          );
          if (boxes.length && live)
            resolve(
              boxes.map((b, i) => [
                b.dataset.poster,
                canvases[i].toDataURL('image/png'),
              ]),
            );
          else if (performance.now() - started > 60_000)
            reject(new Error('not every icon went live'));
          else requestAnimationFrame(tick);
        };
        tick();
      }),
  );
  const tmp = mkdtempSync(join(tmpdir(), 'holo-'));
  for (const [name, url] of shots) {
    if (only.length && !only.includes(name)) continue;
    const cage = name.endsWith('-cage');
    const png = join(tmp, `${name}.png`);
    writeFileSync(png, Buffer.from(url.split(',')[1], 'base64'));
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-i',
      png,
      '-vf',
      `scale=${cage ? 352 : 256}:-1:flags=lanczos`,
      '-c:v',
      'libwebp',
      '-q:v',
      '84',
      join(out, `${name}.webp`),
    ]);
    console.log('wrote', `${name}.webp`);
  }
} finally {
  await browser.close();
}
