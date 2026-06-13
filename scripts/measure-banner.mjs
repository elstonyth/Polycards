// Detect the baked-in "phygitals" wordmark bbox + local banner (cream) & brand
// (purple) colors in claw-machine renders. Loads images SAME-ORIGIN from the running
// server so the canvas isn't tainted. Reports bbox as % of the 1440x1000 image.
import { chromium } from 'playwright';

const machines = [
  'mythic-pack',
  'legend-pack',
  'elite-pack',
  'rookie-pack',
  'diamond-pack',
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:4000/', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});

const res = await page.evaluate(async (machines) => {
  const load = (src) =>
    new Promise((ok, no) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => no(new Error('load ' + src));
      im.src = src;
    });
  const out = {};
  for (const b of machines) {
    try {
      const ext =
        [
          'mythic-pack',
          'legend-pack',
          'elite-pack',
          'rookie-pack',
          'trainer-pack',
        ].includes(b) || true
          ? 'avif'
          : 'webp';
      let img;
      try {
        img = await load(`/images/claw/${b}-machine.avif`);
      } catch {
        img = await load(`/images/claw/${b}-machine.webp`);
      }
      const cv = document.createElement('canvas');
      cv.width = 1440;
      cv.height = 1000;
      const ctx = cv.getContext('2d');
      ctx.drawImage(img, 0, 0, 1440, 1000);
      const data = ctx.getImageData(0, 0, 1440, 1000).data;
      const at = (x, y) => {
        const i = (y * 1440 + x) * 4;
        return [data[i], data[i + 1], data[i + 2]];
      };
      let minX = 1e9,
        minY = 1e9,
        maxX = -1,
        maxY = -1,
        pc = 0,
        pr = 0,
        pg = 0,
        pb = 0;
      for (let y = 70; y < 250; y++)
        for (let x = 400; x < 1040; x++) {
          const [r, g, b2] = at(x, y);
          if (b2 > 90 && b2 > g + 25 && r > g - 10 && b2 < 225 && b2 - g > 30) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
            pc++;
            pr += r;
            pg += g;
            pb += b2;
          }
        }
      let cr = 0,
        cg = 0,
        cb = 0,
        cc = 0;
      for (let y = 120; y < 185; y++)
        for (let x = 425; x < 480; x++) {
          const [r, g, b2] = at(x, y);
          if (r > 185 && g > 180 && b2 > 175) {
            cr += r;
            cg += g;
            cb += b2;
            cc++;
          }
        }
      out[b] = {
        bboxPct: pc
          ? {
              left: +((minX / 1440) * 100).toFixed(1),
              right: +((maxX / 1440) * 100).toFixed(1),
              top: +((minY / 1000) * 100).toFixed(1),
              bottom: +((maxY / 1000) * 100).toFixed(1),
              cx: +(((minX + maxX) / 2 / 1440) * 100).toFixed(1),
              pxCount: pc,
            }
          : 'none',
        purple: pc
          ? `rgb(${Math.round(pr / pc)},${Math.round(pg / pc)},${Math.round(pb / pc)})`
          : '-',
        cream: cc
          ? `rgb(${Math.round(cr / cc)},${Math.round(cg / cc)},${Math.round(cb / cc)})`
          : '-',
      };
    } catch (e) {
      out[b] = { error: e.message };
    }
  }
  return out;
}, machines);

console.log(JSON.stringify(res, null, 2));
await browser.close();
