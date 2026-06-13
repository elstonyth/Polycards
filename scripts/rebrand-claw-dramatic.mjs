// Bake "Pokenic" into the 4 dramatic renders that carry a white "phygitals" banner.
// Sources are loaded as data-URLs (idempotent: always from a -src backup; no server
// staleness, no canvas taint). Reconstruct banner per-row, draw white "Pokenic".
import { chromium } from 'playwright';
import { writeFile, copyFile, readFile, access } from 'node:fs/promises';

const DIR = 'public/images/claw';
// box = [left, right, top, bottom] as fractions of the image
const OVERRIDE = {
  'black-pack-jjnfuk': { box: [0.37, 0.628, 0.112, 0.166], font: 50 },
  'legend-pack-1dpaec': { box: [0.375, 0.628, 0.112, 0.166], font: 38 },
  'modern-grails-noafw0': { box: [0.288, 0.578, 0.115, 0.17], font: 38 },
  'pro-soccer-pack': { box: [0.378, 0.606, 0.115, 0.17], font: 50 },
};

// back up originals once; then read sources from the backups
const inputs = {};
for (const base of Object.keys(OVERRIDE)) {
  const src = `${DIR}/${base}-machine.webp`,
    bak = `${DIR}/${base}-machine-src.webp`;
  try {
    await access(bak);
  } catch {
    await copyFile(src, bak);
  }
  inputs[base] =
    'data:image/webp;base64,' + (await readFile(bak)).toString('base64');
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('about:blank');
await page.addStyleTag({
  content:
    "@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@700&display=swap');",
});
await page.waitForTimeout(1500);
await page.evaluate(async () => {
  try {
    await document.fonts.load('700 50px Poppins');
  } catch {}
});

const results = await page.evaluate(
  async ({ OVERRIDE, inputs }) => {
    const load = (s) =>
      new Promise((ok, no) => {
        const im = new Image();
        im.onload = () => ok(im);
        im.onerror = () => no(new Error('load'));
        im.src = s;
      });
    const out = {};
    for (const [base, cfg] of Object.entries(OVERRIDE)) {
      const img = await load(inputs[base]);
      const W = img.naturalWidth,
        H = img.naturalHeight;
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = H;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, W, H);
      const id = ctx.getImageData(0, 0, W, H);
      const d = id.data;
      const px = (x, y) => {
        const i = (y * W + x) * 4;
        return [d[i], d[i + 1], d[i + 2]];
      };
      const x0 = Math.round(cfg.box[0] * W),
        x1 = Math.round(cfg.box[1] * W),
        y0 = Math.round(cfg.box[2] * H),
        y1 = Math.round(cfg.box[3] * H);
      // STROKE-LEVEL inpaint: replace ONLY the white "phygitals" strokes with the nearest
      // dark-banner pixels on each side — preserves the glowing banner, so NO box/seam.
      const isText = (x, y) => {
        const i = (y * W + x) * 4;
        return Math.min(d[i], d[i + 1], d[i + 2]) > 150;
      };
      const M = Math.round(0.05 * W);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          if (!isText(x, y)) continue;
          let lc = null;
          for (let xx = x - 1; xx >= x0 - M; xx--)
            if (!isText(xx, y)) {
              const i = (y * W + xx) * 4;
              lc = [d[i], d[i + 1], d[i + 2]];
              break;
            }
          let rc = null;
          for (let xx = x + 1; xx <= x1 + M; xx++)
            if (!isText(xx, y)) {
              const i = (y * W + xx) * 4;
              rc = [d[i], d[i + 1], d[i + 2]];
              break;
            }
          const col =
            lc && rc
              ? [(lc[0] + rc[0]) / 2, (lc[1] + rc[1]) / 2, (lc[2] + rc[2]) / 2]
              : lc || rc || [22, 24, 34];
          const i = (y * W + x) * 4;
          d[i] = col[0];
          d[i + 1] = col[1];
          d[i + 2] = col[2];
          d[i + 3] = 255;
        }
      }
      ctx.putImageData(id, 0, 0);
      let fs = cfg.font;
      const maxW = (x1 - x0) * 0.94;
      const fit = () => {
        ctx.font = `700 ${fs}px Poppins, 'Segoe UI', sans-serif`;
        return ctx.measureText('Pokenic').width;
      };
      while (fit() > maxW && fs > 12) fs -= 1;
      ctx.fillStyle = 'rgb(241,243,249)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Pokenic', (x0 + x1) / 2, (y0 + y1) / 2);
      out[base] = { ok: true, fs, data: cv.toDataURL('image/webp', 0.95) };
    }
    return out;
  },
  { OVERRIDE, inputs },
);

for (const [base, r] of Object.entries(results)) {
  if (r.ok) {
    await writeFile(
      `${DIR}/${base}-machine.webp`,
      Buffer.from(r.data.split(',')[1], 'base64'),
    );
    console.log(`${base.padEnd(24)} edited fs=${r.fs}`);
  } else console.log(`${base} ${JSON.stringify(r)}`);
}
await browser.close();
