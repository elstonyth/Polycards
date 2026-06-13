// Zoom into the top banner of a few dramatic machines to read the exact wordmark
// (phygitals vs tier name), its colour and position. Shows top ~24% enlarged + grid.
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const M = [
  { b: 'black-pack-jjnfuk', w: 1440, h: 1000 },
  { b: 'legend-pack-1dpaec', w: 1037, h: 720 },
  { b: 'modern-grails-noafw0', w: 1037, h: 720 },
  { b: 'pro-soccer-pack', w: 1440, h: 1000 },
];
const DW = 1000; // display width
const FRAC = 0.24; // show top 24%
const gridH = (dispH) => {
  let s = '';
  for (let p = 0; p <= 100; p += 5)
    s += `<div style="position:absolute;left:${p}%;top:0;bottom:0;width:1px;background:rgba(0,255,255,.5)"></div><div style="position:absolute;left:${p}%;top:1px;font:10px monospace;color:#ff0;background:#000a">${p}</div>`;
  // horizontal lines at image-y 0,2,..24% mapped into the cropped container
  for (let iy = 0; iy <= 24; iy += 2) {
    const cy = (iy / (FRAC * 100)) * 100;
    s += `<div style="position:absolute;top:${cy}%;left:0;right:0;height:1px;background:rgba(255,80,80,.55)"></div><div style="position:absolute;top:${cy}%;left:2px;font:10px monospace;color:#f88;background:#000a">${iy}</div>`;
  }
  return s;
};
const cells = M.map(({ b, w, h }) => {
  const dispH = DW * (h / w);
  const ch = Math.round(dispH * FRAC);
  return `<div style="margin:6px"><div style="font:13px monospace;color:#fff">${b}  (${w}x${h})</div><div style="position:relative;width:${DW}px;height:${ch}px;overflow:hidden;background:#222"><img src="../../../public/images/claw/${b}-machine.webp" style="width:${DW}px;display:block"/>${gridH(dispH)}</div></div>`;
}).join('');
writeFileSync(
  'docs/research/packdetail/banner-crops.html',
  `<!doctype html><body style="margin:0;background:#111">${cells}</body>`,
);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: DW + 40, height: 1300 },
  deviceScaleFactor: 1.5,
});
await page.goto(
  'file:///' +
    resolve('docs/research/packdetail/banner-crops.html').replace(/\\/g, '/'),
  { waitUntil: 'load' },
);
await page.waitForTimeout(1200);
await page.screenshot({
  path: 'docs/research/packdetail/banner-crops.png',
  fullPage: true,
});
await browser.close();
console.log('rendered banner crops');
