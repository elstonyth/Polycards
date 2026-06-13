// Grid the ORIGINAL banners (still carrying "phygitals") to read the exact wordmark
// line extent + center, for product (mythic avif) and the 4 dramatic (-src webp).
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const M = [
  { f: 'mythic-pack-machine.webp', w: 1440, h: 1000 },
  { f: 'rookie-pack-machine.webp', w: 1440, h: 1000 },
  { f: 'black-pack-jjnfuk-machine.webp', w: 1440, h: 1000 },
  { f: 'legend-pack-1dpaec-machine.webp', w: 1037, h: 720 },
  { f: 'modern-grails-noafw0-machine.webp', w: 1037, h: 720 },
  { f: 'pro-soccer-pack-machine.webp', w: 1440, h: 1000 },
];
const DW = 1000,
  FRAC = 0.3;
const grid = (dispH) => {
  let s = '';
  for (let p = 0; p <= 100; p += 5)
    s += `<div style="position:absolute;left:${p}%;top:0;bottom:0;width:1px;background:rgba(0,255,255,.5)"></div><div style="position:absolute;left:${p}%;top:0;font:10px monospace;color:#ff0;background:#000a">${p}</div>`;
  for (let iy = 0; iy <= 30; iy += 2) {
    const cy = (iy / (FRAC * 100)) * 100;
    s += `<div style="position:absolute;top:${cy}%;left:0;right:0;height:1px;background:rgba(255,90,90,.55)"></div><div style="position:absolute;top:${cy}%;left:2px;font:10px monospace;color:#f88;background:#000a">${iy}</div>`;
  }
  return s;
};
const cells = M.map(({ f, w, h }) => {
  const ch = Math.round(DW * (h / w) * FRAC);
  return `<div style="margin:6px"><div style="font:13px monospace;color:#fff">${f} (${w}x${h})</div><div style="position:relative;width:${DW}px;height:${ch}px;overflow:hidden;background:#222"><img src="../../../public/images/claw/${f}" style="width:${DW}px;display:block"/>${grid(DW * (h / w))}</div></div>`;
}).join('');
writeFileSync(
  'docs/research/packdetail/orig-banners.html',
  `<!doctype html><body style="margin:0;background:#111">${cells}</body>`,
);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: DW + 40, height: 1500 },
  deviceScaleFactor: 1.5,
});
await page.goto(
  'file:///' +
    resolve('docs/research/packdetail/orig-banners.html').replace(/\\/g, '/'),
  { waitUntil: 'load' },
);
await page.waitForTimeout(1200);
await page.screenshot({
  path: 'docs/research/packdetail/orig-banners.png',
  fullPage: true,
});
await browser.close();
console.log('rendered original banners');
