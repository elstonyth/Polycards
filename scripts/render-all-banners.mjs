// Render EVERY machine banner (current baked state) zoomed, to find any residual or
// missed "phygitals" wording. Auto-detects dims; crops the top 26% (the banner).
import { chromium } from 'playwright';
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const DIR = 'public/images/claw';
const files = (await readdir(DIR))
  .filter((f) => /-machine\.webp$/.test(f) && !f.includes('-src'))
  .sort();

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1500, height: 1800 },
  deviceScaleFactor: 1.6,
});
// get dims
const dims = {};
for (const f of files) {
  const wh = await page.evaluate(
    (src) =>
      new Promise((ok) => {
        const im = new Image();
        im.onload = () => ok([im.naturalWidth, im.naturalHeight]);
        im.onerror = () => ok([0, 0]);
        im.src = src;
      }),
    `http://localhost:4000/images/claw/${f}`,
  );
  dims[f] = wh;
}
const DW = 350,
  FRAC = 0.26;
const cells = files
  .map((f) => {
    const [w, h] = dims[f];
    if (!w)
      return `<div style="width:${DW}px;color:#f55;font:11px monospace">${f} FAIL</div>`;
    const ch = Math.round(DW * (h / w) * FRAC);
    return `<div style="margin:3px"><div style="font:10px monospace;color:#fff">${f.replace('-machine.webp', '')}</div><div style="width:${DW}px;height:${ch}px;overflow:hidden;background:#333"><img src="../../../public/images/claw/${f}" style="width:${DW}px;display:block"/></div></div>`;
  })
  .join('');
writeFileSync(
  `${DIR.replace('public/images/claw', 'docs/research/packdetail')}/all-banners.html`,
  `<!doctype html><body style="margin:0;background:#111;display:flex;flex-wrap:wrap">${cells}</body>`,
);

await page.goto(
  'file:///' +
    resolve('docs/research/packdetail/all-banners.html').replace(/\\/g, '/'),
  { waitUntil: 'load' },
);
await page.waitForTimeout(1500);
await page.screenshot({
  path: 'docs/research/packdetail/all-banners.png',
  fullPage: true,
});
await browser.close();
console.log(`rendered ${files.length} banners`);
