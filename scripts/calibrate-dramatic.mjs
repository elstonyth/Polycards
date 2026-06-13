// The 10 webp-only ("dramatic") claw renders use a different camera than the light
// product shots. Render them with a % grid to find the "phygitals" banner position
// and check consistency. Also reports natural dims.
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const DRAMATIC = [
  'black-pack-jjnfuk',
  'elite-football-pack',
  'legend-baseball-pack',
  'legend-pack-1dpaec',
  'modern-grails-noafw0',
  'platinum-football-pack',
  'pro-baseball-pack',
  'pro-soccer-pack',
  'starter-baseball-pack',
  'starter-football-pack',
];
const W = 320;
const grid = () => {
  let s = '';
  for (let p = 0; p <= 100; p += 5) {
    const major = p % 10 === 0;
    s += `<div style="position:absolute;left:${p}%;top:0;bottom:0;width:1px;background:rgba(0,255,255,${major ? 0.6 : 0.25})"></div>`;
    s += `<div style="position:absolute;top:${p}%;left:0;right:0;height:1px;background:rgba(0,255,255,${major ? 0.6 : 0.25})"></div>`;
    if (major)
      s += `<div style="position:absolute;left:${p}%;top:0;font:9px monospace;color:#ff0">${p}</div><div style="position:absolute;top:${p}%;left:1px;font:9px monospace;color:#ff0">${p}</div>`;
  }
  return s;
};
const cells = DRAMATIC.map(
  (b) =>
    `<div style="margin:5px"><div style="font:11px monospace;color:#fff">${b}</div><div style="position:relative;width:${W}px;background:#333"><img src="../../../public/images/claw/${b}-machine.webp" style="width:${W}px;display:block"/>${grid()}</div></div>`,
).join('');
writeFileSync(
  'docs/research/packdetail/calibrate-dramatic.html',
  `<!doctype html><body style="margin:0;background:#111;display:flex;flex-wrap:wrap">${cells}</body>`,
);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1700, height: 900 },
  deviceScaleFactor: 1.4,
});
await page.goto(
  'file:///' +
    resolve('docs/research/packdetail/calibrate-dramatic.html').replace(
      /\\/g,
      '/',
    ),
  { waitUntil: 'load' },
);
await page.waitForTimeout(1500);
const dims = await page.evaluate(() =>
  [...document.querySelectorAll('img')].map(
    (i, n) => i.naturalWidth + 'x' + i.naturalHeight,
  ),
);
await page.screenshot({
  path: 'docs/research/packdetail/calibrate-dramatic.png',
  fullPage: true,
});
await browser.close();
console.log('dims:', dims.join(', '));
