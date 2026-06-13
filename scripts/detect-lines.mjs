// Precisely locate the "phygitals" wordmark LINE by detecting text rows on the sign
// and taking the upper line. Product = purple text; dramatic = white text. Restricts
// x to the central band to avoid the machine frame. Reports band + clean sample rows.
import { chromium } from 'playwright';

const T = [
  {
    base: 'mythic-pack',
    file: 'mythic-pack-machine.avif',
    kind: 'purple',
    W: 1440,
    H: 1000,
  },
  {
    base: 'black-pack-jjnfuk',
    file: 'black-pack-jjnfuk-machine-src.webp',
    kind: 'white',
    W: 1440,
    H: 1000,
  },
  {
    base: 'legend-pack-1dpaec',
    file: 'legend-pack-1dpaec-machine-src.webp',
    kind: 'white',
    W: 1037,
    H: 720,
  },
  {
    base: 'modern-grails-noafw0',
    file: 'modern-grails-noafw0-machine-src.webp',
    kind: 'white',
    W: 1037,
    H: 720,
  },
  {
    base: 'pro-soccer-pack',
    file: 'pro-soccer-pack-machine-src.webp',
    kind: 'white',
    W: 1440,
    H: 1000,
  },
];

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('http://localhost:4000/', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});

const res = await page.evaluate(async (T) => {
  const load = (s) =>
    new Promise((ok, no) => {
      const im = new Image();
      im.onload = () => ok(im);
      im.onerror = () => no(new Error(s));
      im.src = s;
    });
  const out = {};
  for (const { base, file, kind, W, H } of T) {
    let img;
    try {
      img = await load(`/images/claw/${file}`);
    } catch {
      out[base] = { err: file };
      continue;
    }
    const cv = document.createElement('canvas');
    cv.width = W;
    cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const hit = (x, y) => {
      const i = (y * W + x) * 4,
        r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      return kind === 'purple'
        ? b - g > 14 && b > 120
        : Math.min(r, g, b) > 165;
    };
    const xa = Math.round(W * 0.33),
      xb = Math.round(W * 0.67),
      ya = Math.round(H * 0.03),
      yb = Math.round(H * 0.27);
    // rows with text
    const rows = [];
    for (let y = ya; y < yb; y++) {
      let c = 0;
      for (let x = xa; x < xb; x++) if (hit(x, y)) c++;
      rows.push({ y, c, on: c >= 10 });
    }
    // group consecutive on-rows into lines
    const lines = [];
    let cur = null;
    for (const r of rows) {
      if (r.on) {
        if (!cur) cur = { y0: r.y, y1: r.y };
        else cur.y1 = r.y;
      } else if (cur) {
        lines.push(cur);
        cur = null;
      }
    }
    if (cur) lines.push(cur);
    const top = lines[0];
    let xmin = 1e9,
      xmax = -1;
    if (top)
      for (let y = top.y0; y <= top.y1; y++)
        for (let x = xa; x < xb; x++)
          if (hit(x, y)) {
            if (x < xmin) xmin = x;
            if (x > xmax) xmax = x;
          }
    out[base] = top
      ? {
          dims: `${W}x${H}`,
          line_y: {
            t: +((top.y0 / H) * 100).toFixed(1),
            b: +((top.y1 / H) * 100).toFixed(1),
          },
          line_x: {
            l: +((xmin / W) * 100).toFixed(1),
            r: +((xmax / W) * 100).toFixed(1),
            cx: +(((xmin + xmax) / 2 / W) * 100).toFixed(1),
          },
          lines: lines.map(
            (l) =>
              `${((l.y0 / H) * 100).toFixed(1)}-${((l.y1 / H) * 100).toFixed(1)}`,
          ),
        }
      : { none: true, lines: 0 };
  }
  return out;
}, T);

console.log(JSON.stringify(res, null, 2));
await browser.close();
