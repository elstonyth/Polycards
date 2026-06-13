// DEFINITIVE claw re-brand. Removes "phygitals" by STROKE-LEVEL inpaint (recolours
// ONLY the wordmark's own pixels + glow to the nearest banner pixel on each side) —
// so the white sign / dark banner is left untouched: no band-fill, no edge streaks,
// no box. Then draws a centred "Pokenic". Bands/centres come from detect-lines.mjs.
// Sources loaded as data-URLs (clean originals; idempotent; no taint).
import { chromium } from 'playwright';
import { writeFile, readFile } from 'node:fs/promises';

const DIR = 'public/images/claw';
const PRODUCT_BASES = [
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
];
// kind: purple (dark text on white sign) | white (bright text on dark banner)
// band = search rectangle (generous, only text/glow pixels get changed)
// cx/cy = where to centre "Pokenic" (the wordmark centre), %.
const PRODUCT_CFG = {
  src: 'avif',
  kind: 'purple',
  band: [33, 67, 14, 23],
  color: 'rgb(104,108,190)',
  cx: 48.8,
  cy: 18.3,
  font: 56,
};

const JOBS = [];
for (const b of PRODUCT_BASES)
  JOBS.push({ base: b, file: `${b}-machine.avif`, ...PRODUCT_CFG });
JOBS.push({
  base: 'black-pack-jjnfuk',
  file: 'black-pack-jjnfuk-machine-src.webp',
  kind: 'white',
  band: [34, 66, 8.5, 18],
  color: 'rgb(245,247,252)',
  cx: 49.4,
  cy: 13.3,
  font: 50,
});
JOBS.push({
  base: 'legend-pack-1dpaec',
  file: 'legend-pack-1dpaec-machine-src.webp',
  kind: 'white',
  band: [34, 66, 8.5, 18],
  color: 'rgb(245,247,252)',
  cx: 49.3,
  cy: 13.3,
  font: 40,
});
JOBS.push({
  base: 'modern-grails-noafw0',
  file: 'modern-grails-noafw0-machine-src.webp',
  kind: 'white',
  band: [30, 64, 8.5, 18],
  color: 'rgb(245,247,252)',
  cx: 49,
  cy: 13.3,
  font: 40,
});
JOBS.push({
  base: 'pro-soccer-pack',
  file: 'pro-soccer-pack-machine-src.webp',
  kind: 'white',
  band: [34, 64, 8.5, 17],
  color: 'rgb(245,247,252)',
  cx: 49.4,
  cy: 12.6,
  font: 50,
});

const inputs = {};
for (const j of JOBS) {
  const buf = await readFile(`${DIR}/${j.file}`);
  inputs[j.base] =
    `data:${j.file.endsWith('.avif') ? 'image/avif' : 'image/webp'};base64,${buf.toString('base64')}`;
}

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:4000/', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});
await page.addStyleTag({
  content:
    "@import url('https://fonts.googleapis.com/css2?family=Poppins:wght@700&display=swap');",
});
await page.waitForTimeout(1800);
await page.evaluate(async () => {
  try {
    await document.fonts.load('700 50px Poppins');
  } catch {}
});

const results = await page.evaluate(
  async ({ JOBS, inputs }) => {
    const load = (s) =>
      new Promise((ok, no) => {
        const im = new Image();
        im.onload = () => ok(im);
        im.onerror = () => no(new Error('load'));
        im.src = s;
      });
    const out = {};
    for (const j of JOBS) {
      const img = await load(inputs[j.base]);
      const W = img.naturalWidth,
        H = img.naturalHeight;
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = H;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, W, H);
      const id = ctx.getImageData(0, 0, W, H);
      const d = id.data;
      const x0 = Math.round((j.band[0] / 100) * W),
        x1 = Math.round((j.band[1] / 100) * W);
      const y0 = Math.round((j.band[2] / 100) * H),
        y1 = Math.round((j.band[3] / 100) * H);
      const isText = (x, y) => {
        const i = (y * W + x) * 4,
          r = d[i],
          g = d[i + 1],
          b = d[i + 2];
        return j.kind === 'purple'
          ? b - g > 5 && b > 110
          : Math.min(r, g, b) > 138;
      };
      const M = x1 - x0;
      const fb = j.kind === 'purple' ? [240, 240, 243] : [20, 22, 32];
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
              : lc || rc || fb;
          const i = (y * W + x) * 4;
          d[i] = col[0];
          d[i + 1] = col[1];
          d[i + 2] = col[2];
          d[i + 3] = 255;
        }
      }
      ctx.putImageData(id, 0, 0);
      let fs = j.font;
      const maxW = (x1 - x0) * 0.62;
      const fit = () => {
        ctx.font = `700 ${fs}px Poppins, 'Segoe UI', sans-serif`;
        return ctx.measureText('Pokenic').width;
      };
      while (fit() > maxW && fs > 12) fs -= 1;
      ctx.fillStyle = j.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Pokenic', (j.cx / 100) * W, (j.cy / 100) * H);
      out[j.base] = { ok: true, fs, data: cv.toDataURL('image/webp', 0.95) };
    }
    return out;
  },
  { JOBS, inputs },
);

let n = 0;
for (const [base, r] of Object.entries(results)) {
  if (r.ok) {
    await writeFile(
      `${DIR}/${base}-machine.webp`,
      Buffer.from(r.data.split(',')[1], 'base64'),
    );
    n++;
  } else console.log(base, r);
}
console.log(`${n} re-branded`);
await browser.close();
