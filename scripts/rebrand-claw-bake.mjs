// Bake the Pokenic re-brand INTO the claw-machine renders (no runtime overlay box).
// For the uniform 1440x1000 product shots: remove "phygitals" by reconstructing the
// banner from its own neighbouring pixels (per-row edge interpolation → seamless, no
// box, exact colour/shading), then draw "Pokenic" in the original's sampled purple.
// Loads source images SAME-ORIGIN (no canvas taint); writes edited webp to disk.
import { chromium } from 'playwright';
import { writeFile } from 'node:fs/promises';

const PRODUCT = [
  'mythic-pack',
  'legend-pack',
  'elite-pack',
  'platinum-pack',
  'rookie-pack',
  'trainer-pack',
  'elite-one-piece-pack',
  'legend-one-piece-pack',
  'one-piece-platinum-pack',
  'one-piece-sealed-claw-mcmnf5',
  'starter-one-piece-pack',
  'starter-riftbound-pack',
  'yugioh-pro-pack',
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:4000/', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});
// load a clean geometric font close to the original wordmark
await page.addStyleTag({
  content:
    "@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@700&display=swap');",
});
await page.waitForTimeout(1800);
await page.evaluate(async () => {
  try {
    await document.fonts.load('700 56px Poppins');
  } catch {}
});

const results = await page.evaluate(async (PRODUCT) => {
  const load = (src) =>
    new Promise((ok, no) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => no(new Error(src));
      im.src = src;
    });
  const out = {};
  for (const base of PRODUCT) {
    let img;
    try {
      img = await load(`/images/claw/${base}-machine.avif`);
    } catch {
      try {
        img = await load(`/images/claw/${base}-machine.webp`);
      } catch {
        out[base] = { err: 'load' };
        continue;
      }
    }
    if (img.naturalWidth !== 1440 || img.naturalHeight !== 1000) {
      out[base] = { skip: img.naturalWidth + 'x' + img.naturalHeight };
      continue;
    }

    const cv = document.createElement('canvas');
    cv.width = 1440;
    cv.height = 1000;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, 1440, 1000);
    const id = ctx.getImageData(0, 0, 1440, 1000);
    const d = id.data;
    const px = (x, y) => {
      const i = (y * 1440 + x) * 4;
      return [d[i], d[i + 1], d[i + 2]];
    };

    // "phygitals" brand line bbox (validated visually): x 30–58.5%, y 14.7–21.3%
    const x0 = 432,
      x1 = 842,
      y0 = 147,
      y1 = 213;

    // The "phygitals" wordmark is the same periwinkle on every render — use it fixed
    // (per-image sampling caught machine-frame colour on a few packs).
    const purple = 'rgb(104,108,190)';

    // STROKE-LEVEL inpaint: replace ONLY the purple "phygitals" strokes with the
    // nearest banner pixels on each side. This preserves the banner's curve/shading
    // everywhere else, so there is NO rectangle/box/seam (the previous rect fill did).
    const isText = (x, y) => {
      const i = (y * 1440 + x) * 4;
      return d[i + 2] - d[i + 1] > 8 && d[i + 2] > 115;
    };
    const M = Math.round(0.04 * 1440);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (!isText(x, y)) continue;
        let lc = null;
        for (let xx = x - 1; xx >= x0 - M; xx--)
          if (!isText(xx, y)) {
            const i = (y * 1440 + xx) * 4;
            lc = [d[i], d[i + 1], d[i + 2]];
            break;
          }
        let rc = null;
        for (let xx = x + 1; xx <= x1 + M; xx++)
          if (!isText(xx, y)) {
            const i = (y * 1440 + xx) * 4;
            rc = [d[i], d[i + 1], d[i + 2]];
            break;
          }
        const col =
          lc && rc
            ? [(lc[0] + rc[0]) / 2, (lc[1] + rc[1]) / 2, (lc[2] + rc[2]) / 2]
            : lc || rc || [214, 215, 218];
        const i = (y * 1440 + x) * 4;
        d[i] = col[0];
        d[i + 1] = col[1];
        d[i + 2] = col[2];
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(id, 0, 0);

    // draw "Pokenic" centred in the bbox, in the sampled purple, auto-fit width
    let fs = 60;
    const fit = () => {
      ctx.font = `700 ${fs}px Poppins, 'Segoe UI', sans-serif`;
      return ctx.measureText('Pokenic').width;
    };
    while (fit() > 360 && fs > 20) fs -= 2;
    ctx.fillStyle = purple;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Pokenic', (x0 + x1) / 2, (y0 + y1) / 2 + 1);

    out[base] = {
      ok: true,
      purple,
      fs,
      data: cv.toDataURL('image/webp', 0.95),
    };
  }
  return out;
}, PRODUCT);

let edited = 0;
for (const [base, r] of Object.entries(results)) {
  if (r.ok) {
    await writeFile(
      `public/images/claw/${base}-machine.webp`,
      Buffer.from(r.data.split(',')[1], 'base64'),
    );
    console.log(`${base.padEnd(30)} edited  purple=${r.purple} fs=${r.fs}`);
    edited++;
  } else console.log(`${base.padEnd(30)} ${JSON.stringify(r)}`);
}
console.log(`\n${edited} images re-branded`);
await browser.close();
