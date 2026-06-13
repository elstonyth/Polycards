// Render the 11 rebranded machine banners larger to check "Pokenic" alignment
// (horizontal centring on the banner + vertical position). Cyan line = image centre 50%.
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
  'starter-riftbound-pack',
  'black-pack-jjnfuk',
  'legend-pack-1dpaec',
  'modern-grails-noafw0',
  'pro-soccer-pack',
];
const DW = 460,
  FRAC = 0.28;

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1500, height: 1700 },
  deviceScaleFactor: 1.6,
});
const dims = {};
for (const b of BASES)
  dims[b] = await page.evaluate(
    (s) =>
      new Promise((ok) => {
        const im = new Image();
        im.onload = () => ok([im.naturalWidth, im.naturalHeight]);
        im.onerror = () => ok([1440, 1000]);
        im.src = s;
      }),
    `http://localhost:4000/images/claw/${b}-machine.webp`,
  );

const cells = BASES.map((b) => {
  const [w, h] = dims[b];
  const ch = Math.round(DW * (h / w) * FRAC);
  return `<div style="margin:4px"><div style="font:11px monospace;color:#fff">${b}</div><div style="position:relative;width:${DW}px;height:${ch}px;overflow:hidden;background:#333"><img src="../../../public/images/claw/${b}-machine.webp" style="width:${DW}px;display:block"/><div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:rgba(0,255,255,.8)"></div></div></div>`;
}).join('');
writeFileSync(
  'docs/research/packdetail/align.html',
  `<!doctype html><body style="margin:0;background:#111;display:flex;flex-wrap:wrap">${cells}</body>`,
);
await page.goto(
  'file:///' +
    resolve('docs/research/packdetail/align.html').replace(/\\/g, '/'),
  { waitUntil: 'load' },
);
await page.waitForTimeout(1200);
await page.screenshot({
  path: 'docs/research/packdetail/align.png',
  fullPage: true,
});
await browser.close();
console.log('rendered');
