// Locate the white "phygitals" wordmark on the dramatic banners (tier names are
// COLOURED, phygitals is WHITE) by detecting near-white horizontal text clusters in
// the top band. Reports bbox % + dims + density so we can bake per-image.
import { chromium } from 'playwright';

const DRAMATIC = [
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

const res = await page.evaluate(async (DRAMATIC) => {
  const load = (src) =>
    new Promise((ok, no) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => no(new Error(src));
      im.src = src;
    });
  const out = {};
  for (const base of DRAMATIC) {
    let img;
    try {
      img = await load(`/images/claw/${base}-machine.webp`);
    } catch {
      out[base] = { err: 1 };
      continue;
    }
    const W = img.naturalWidth,
      H = img.naturalHeight;
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const isWhite = (x, y) => {
      const i = (y * W + x) * 4;
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      return (
        Math.min(r, g, b) > 168 && Math.max(r, g, b) - Math.min(r, g, b) < 46
      );
    };
    // per-row white density in top band; find the row-band with a dense horizontal run
    const y0 = Math.round(H * 0.02),
      y1 = Math.round(H * 0.17),
      x0 = Math.round(W * 0.08),
      x1 = Math.round(W * 0.92);
    let minX = 1e9,
      minY = 1e9,
      maxX = -1,
      maxY = -1,
      pc = 0;
    const rowCounts = {};
    for (let y = y0; y < y1; y++) {
      let c = 0;
      for (let x = x0; x < x1; x++) if (isWhite(x, y)) c++;
      rowCounts[y] = c;
    }
    // only count rows that have a real text run (>= 25 white px) to avoid stray highlights
    for (let y = y0; y < y1; y++) {
      if (rowCounts[y] < 25) continue;
      for (let x = x0; x < x1; x++)
        if (isWhite(x, y)) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
          pc++;
        }
    }
    out[base] = {
      dims: `${W}x${H}`,
      whiteCount: pc,
      bboxPct:
        pc > 120
          ? {
              l: +((minX / W) * 100).toFixed(1),
              r: +((maxX / W) * 100).toFixed(1),
              t: +((minY / H) * 100).toFixed(1),
              b: +((maxY / H) * 100).toFixed(1),
            }
          : 'none',
    };
  }
  return out;
}, DRAMATIC);

console.log(JSON.stringify(res, null, 2));
await browser.close();
