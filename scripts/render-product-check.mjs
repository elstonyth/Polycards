// Zoom every PRODUCT-shot banner + report dims, to find any with residual "phygitals"
// or a different render position (the bake assumes 1440x1000, wordmark at y16-22%).
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const BASES = [
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
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1500, height: 1700 },
  deviceScaleFactor: 1.6,
});
const dims = {};
for (const b of BASES)
  dims[b] = await page.evaluate(
    (src) =>
      new Promise((ok) => {
        const im = new Image();
        im.onload = () => ok([im.naturalWidth, im.naturalHeight]);
        im.onerror = () => ok([0, 0]);
        im.src = src;
      }),
    `http://localhost:4000/images/claw/${b}-machine.webp`,
  );

const DW = 460,
  FRAC = 0.26;
const cells = BASES.map((b) => {
  const [w, h] = dims[b];
  const ch = Math.round(DW * (h / w) * FRAC);
  return `<div style="margin:4px"><div style="font:12px monospace;color:#fff">${b} (${w}x${h})</div><div style="width:${DW}px;height:${ch}px;overflow:hidden;background:#333"><img src="../../../public/images/claw/${b}-machine.webp" style="width:${DW}px;display:block"/></div></div>`;
}).join('');
writeFileSync(
  'docs/research/packdetail/product-check.html',
  `<!doctype html><body style="margin:0;background:#111;display:flex;flex-wrap:wrap">${cells}</body>`,
);
await page.goto(
  'file:///' +
    resolve('docs/research/packdetail/product-check.html').replace(/\\/g, '/'),
  { waitUntil: 'load' },
);
await page.waitForTimeout(1200);
await page.screenshot({
  path: 'docs/research/packdetail/product-check.png',
  fullPage: true,
});
await browser.close();
console.log('dims:', JSON.stringify(dims));
