// Locate the small bottom-front "phygitals" / "phygitals.com" branding on a product
// (mythic avif) and a dramatic (black-pack -src) machine, with a grid to read it.
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const M = [
  { f: 'mythic-pack-machine.avif', w: 1440, h: 1000 },
  { f: 'black-pack-jjnfuk-machine-src.webp', w: 1440, h: 1000 },
];
const DW = 1100,
  TOP = 0.6,
  FRAC = 0.4; // show y 60%..100%
const grid = (dispH) => {
  let s = '';
  for (let p = 0; p <= 100; p += 5)
    s += `<div style="position:absolute;left:${p}%;top:0;bottom:0;width:1px;background:rgba(0,255,255,.5)"></div><div style="position:absolute;left:${p}%;top:0;font:10px monospace;color:#ff0;background:#000a">${p}</div>`;
  for (let iy = 60; iy <= 100; iy += 2) {
    const cy = ((iy - TOP * 100) / (FRAC * 100)) * 100;
    s += `<div style="position:absolute;top:${cy}%;left:0;right:0;height:1px;background:rgba(255,90,90,.5)"></div><div style="position:absolute;top:${cy}%;left:2px;font:10px monospace;color:#f88;background:#000a">${iy}</div>`;
  }
  return s;
};
const cells = M.map(({ f, w, h }) => {
  const dispH = DW * (h / w);
  const ch = Math.round(dispH * FRAC);
  return `<div style="margin:6px"><div style="font:13px monospace;color:#fff">${f}</div><div style="position:relative;width:${DW}px;height:${ch}px;overflow:hidden;background:#222"><img src="../../../public/images/claw/${f}" style="position:absolute;width:${DW}px;top:${-Math.round(dispH * TOP)}px"/>${grid(dispH)}</div></div>`;
}).join('');
writeFileSync(
  'docs/research/packdetail/bottom.html',
  `<!doctype html><body style="margin:0;background:#111">${cells}</body>`,
);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: DW + 40, height: 1000 },
  deviceScaleFactor: 1.6,
});
await page.goto(
  'file:///' +
    resolve('docs/research/packdetail/bottom.html').replace(/\\/g, '/'),
  { waitUntil: 'load' },
);
await page.waitForTimeout(1000);
await page.screenshot({
  path: 'docs/research/packdetail/bottom.png',
  fullPage: true,
});
await browser.close();
console.log('rendered bottom');
