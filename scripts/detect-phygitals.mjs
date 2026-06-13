// Detect the "phygitals" wordmark bbox in the remaining 11 renders (yugioh 1440x900
// + 10 dramatic webp-only). Tries periwinkle-purple detection; reports bbox %, dims,
// and pixel count so we can bake per-image. Loads same-origin (no taint).
import { chromium } from 'playwright';

const REMAIN = [
  'yugioh-pro-pack',
  'black-pack-jjnfuk',
  'elite-football-pack',
  'legend-baseball-pack',
  'legend-pack-1dpaec',
  'modern-grails-noafw0',
  'platinum-football-pack',
  'pro-baseball-pack',
  'pro-soccer-pack',
  'starter-baseball-pack',
  'starter-football-pack',
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:4000/', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});

const res = await page.evaluate(async (REMAIN) => {
  const load = (src) =>
    new Promise((ok, no) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => no(new Error(src));
      im.src = src;
    });
  const out = {};
  for (const base of REMAIN) {
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
    const W = img.naturalWidth,
      H = img.naturalHeight;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const px = (x, y) => {
      const i = (y * W + x) * 4;
      return [d[i], d[i + 1], d[i + 2]];
    };
    // periwinkle-purple text in the top 40%, central 30-70%
    let minX = 1e9,
      minY = 1e9,
      maxX = -1,
      maxY = -1,
      pc = 0;
    const y0 = Math.round(H * 0.03),
      y1 = Math.round(H * 0.42),
      x0 = Math.round(W * 0.28),
      x1 = Math.round(W * 0.72);
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const [r, g, b] = px(x, y);
        if (b > 95 && b > g + 22 && r > g - 18 && r < b + 40 && b < 235) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          pc++;
        }
      }
    out[base] = {
      dims: `${W}x${H}`,
      purpleCount: pc,
      bboxPct:
        pc > 60
          ? {
              l: +((minX / W) * 100).toFixed(1),
              r: +((maxX / W) * 100).toFixed(1),
              t: +((minY / H) * 100).toFixed(1),
              b: +((maxY / H) * 100).toFixed(1),
            }
          : 'weak',
    };
  }
  return out;
}, REMAIN);

console.log(JSON.stringify(res, null, 2));
await browser.close();
