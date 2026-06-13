// Calibrate the "phygitals" wordmark position inside the claw-machine renders.
// Renders 3 machines (different colors) at a fixed width with a 5% grid so we can
// read off the banner box as a % of the image — and confirm it's consistent.
import { chromium } from 'playwright';
import { resolve } from 'node:path';

const DIR = 'public/images/claw';
const MACHINES = ['mythic-pack', 'legend-pack', 'elite-pack']; // all have avif
const W = 560;

const gridLines = () => {
  let s = '';
  for (let p = 0; p <= 100; p += 5) {
    const major = p % 10 === 0;
    s += `<div style="position:absolute;left:${p}%;top:0;bottom:0;width:1px;background:rgba(255,0,0,${major ? 0.55 : 0.25})"></div>`;
    s += `<div style="position:absolute;top:${p}%;left:0;right:0;height:1px;background:rgba(255,0,0,${major ? 0.55 : 0.25})"></div>`;
    if (major) {
      s += `<div style="position:absolute;left:${p}%;top:0;font:10px monospace;color:#0ff">${p}</div>`;
      s += `<div style="position:absolute;top:${p}%;left:0;font:10px monospace;color:#0ff">${p}</div>`;
    }
  }
  return s;
};

const cells = MACHINES.map((b) => {
  const src = `../../../public/images/claw/${b}-machine.avif`;
  return `<div style="position:relative;width:${W}px;margin:6px"><div style="font:12px monospace;color:#fff">${b}</div><div style="position:relative;width:${W}px;background:#777"><img src="${src}" style="width:${W}px;display:block"/>${gridLines()}</div></div>`;
}).join('');
const html = `<!doctype html><body style="margin:0;background:#222;display:flex;flex-wrap:wrap;padding:8px">${cells}</body>`;

import { writeFileSync } from 'node:fs';
writeFileSync('docs/research/packdetail/calibrate.html', html);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1800, height: 900 },
  deviceScaleFactor: 1.5,
});
await page.goto(
  'file:///' +
    resolve('docs/research/packdetail/calibrate.html').replace(/\\/g, '/'),
  { waitUntil: 'load' },
);
await page.waitForTimeout(1500);
// also dump natural dims
const dims = await page.evaluate(() =>
  [...document.querySelectorAll('img')].map(
    (i) => i.naturalWidth + 'x' + i.naturalHeight,
  ),
);
await page.screenshot({
  path: 'docs/research/packdetail/calibrate.png',
  fullPage: true,
});
await browser.close();
console.log('natural dims:', dims.join(', '));
