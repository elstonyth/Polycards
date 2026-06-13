// Measure the FULL "phygitals" extent (incl. faint glow/halo) on the product render
// (mythic avif) and the 4 dramatic -src webps, so the bake band fully covers it and
// Pokenic is centred on it. Same-origin load (no taint).
import { chromium } from 'playwright';

const TARGETS = [
  { base: 'mythic-pack', file: 'mythic-pack-machine.avif', kind: 'purple' },
  {
    base: 'black-pack-jjnfuk',
    file: 'black-pack-jjnfuk-machine-src.webp',
    kind: 'white',
  },
  {
    base: 'legend-pack-1dpaec',
    file: 'legend-pack-1dpaec-machine-src.webp',
    kind: 'white',
  },
  {
    base: 'modern-grails-noafw0',
    file: 'modern-grails-noafw0-machine-src.webp',
    kind: 'white',
  },
  {
    base: 'pro-soccer-pack',
    file: 'pro-soccer-pack-machine-src.webp',
    kind: 'white',
  },
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:4000/', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});

const res = await page.evaluate(async (TARGETS) => {
  const load = (s) =>
    new Promise((ok, no) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => no(new Error(s));
      im.src = s;
    });
  const out = {};
  for (const { base, file, kind } of TARGETS) {
    let img;
    try {
      img = await load(`/images/claw/${file}`);
    } catch {
      out[base] = { err: file };
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
    const px = (x, y) => {
      const i = (y * W + x) * 4;
      return [d[i], d[i + 1], d[i + 2]];
    };
    // scan top band; require a per-ROW run so we capture the wordmark line not stray px
    const y0 = Math.round(H * 0.03),
      y1 = Math.round(H * 0.28),
      x0 = Math.round(W * 0.2),
      x1 = Math.round(W * 0.8);
    const hit = (x, y) => {
      const [r, g, b] = px(x, y);
      return kind === 'purple' ? b - g > 6 && b > 108 : Math.min(r, g, b) > 120;
    };
    // find the densest contiguous row-band of hits (the wordmark line)
    let minX = 1e9,
      minY = 1e9,
      maxX = -1,
      maxY = -1;
    for (let y = y0; y < y1; y++) {
      let c = 0,
        rmin = 1e9,
        rmax = -1;
      for (let x = x0; x < x1; x++)
        if (hit(x, y)) {
          c++;
          if (x < rmin) rmin = x;
          if (x > rmax) rmax = x;
        }
      if (c >= 18) {
        if (rmin < minX) minX = rmin;
        if (rmax > maxX) maxX = rmax;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    out[base] = {
      dims: `${W}x${H}`,
      bboxPct:
        maxX > 0
          ? {
              l: +((minX / W) * 100).toFixed(1),
              r: +((maxX / W) * 100).toFixed(1),
              t: +((minY / H) * 100).toFixed(1),
              b: +((maxY / H) * 100).toFixed(1),
              cx: +(((minX + maxX) / 2 / W) * 100).toFixed(1),
            }
          : 'none',
    };
  }
  return out;
}, TARGETS);

console.log(JSON.stringify(res, null, 2));
await browser.close();
