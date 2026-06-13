// Show the ORIGINAL one-piece banners (avif) with a grid to see their actual text +
// position (they look different from the pokemon product shots).
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const M = [
  'elite-one-piece-pack',
  'legend-one-piece-pack',
  'one-piece-platinum-pack',
  'one-piece-sealed-claw-mcmnf5',
  'starter-one-piece-pack',
];
const DW = 1000,
  FRAC = 0.3;
const grid = () => {
  let s = '';
  for (let p = 0; p <= 100; p += 5)
    s += `<div style="position:absolute;left:${p}%;top:0;bottom:0;width:1px;background:rgba(0,255,255,.5)"></div><div style="position:absolute;left:${p}%;top:0;font:10px monospace;color:#ff0;background:#000a">${p}</div>`;
  for (let iy = 0; iy <= 30; iy += 2) {
    const cy = (iy / (FRAC * 100)) * 100;
    s += `<div style="position:absolute;top:${cy}%;left:0;right:0;height:1px;background:rgba(255,90,90,.5)"></div><div style="position:absolute;top:${cy}%;left:2px;font:10px monospace;color:#f88;background:#000a">${iy}</div>`;
  }
  return s;
};
const cells = M.map((b) => {
  const ch = Math.round(DW * (1000 / 1440) * FRAC);
  return `<div style="margin:6px"><div style="font:13px monospace;color:#fff">${b}.avif</div><div style="position:relative;width:${DW}px;height:${ch}px;overflow:hidden;background:#222"><img src="../../../public/images/claw/${b}-machine.avif" style="width:${DW}px;display:block"/>${grid()}</div></div>`;
}).join('');
writeFileSync(
  'docs/research/packdetail/onepiece-orig.html',
  `<!doctype html><body style="margin:0;background:#111">${cells}</body>`,
);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: DW + 40, height: 1500 },
  deviceScaleFactor: 1.5,
});
await page.goto(
  'file:///' +
    resolve('docs/research/packdetail/onepiece-orig.html').replace(/\\/g, '/'),
  { waitUntil: 'load' },
);
await page.waitForTimeout(1200);
await page.screenshot({
  path: 'docs/research/packdetail/onepiece-orig.png',
  fullPage: true,
});
await browser.close();
console.log('rendered');
