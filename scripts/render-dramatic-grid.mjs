// Render the 10 dramatic renders large with a fine grid to read each "phygitals"
// bbox (% of image) and its text colour, so we can bake them per-image.
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
const W = 520;
const grid = () => {
  let s = '';
  for (let p = 0; p <= 100; p += 2.5) {
    const major = p % 10 === 0;
    s += `<div style="position:absolute;left:${p}%;top:0;bottom:0;width:1px;background:rgba(0,255,255,${major ? 0.7 : 0.22})"></div>`;
    s += `<div style="position:absolute;top:${p}%;left:0;right:0;height:1px;background:rgba(0,255,255,${major ? 0.7 : 0.22})"></div>`;
    if (major)
      s += `<div style="position:absolute;left:${p}%;top:1px;font:9px monospace;color:#ff0;background:#0008">${p}</div><div style="position:absolute;top:${p}%;left:1px;font:9px monospace;color:#ff0;background:#0008">${p}</div>`;
  }
  return s;
};
const cells = DRAMATIC.map(
  (b) =>
    `<div style="margin:4px"><div style="font:12px monospace;color:#fff">${b}</div><div style="position:relative;width:${W}px;background:#222"><img src="../../../public/images/claw/${b}-machine.webp" style="width:${W}px;display:block"/>${grid()}</div></div>`,
).join('');
writeFileSync(
  'docs/research/packdetail/dramatic-grid.html',
  `<!doctype html><body style="margin:0;background:#111;display:flex;flex-wrap:wrap">${cells}</body>`,
);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1120, height: 900 },
  deviceScaleFactor: 2,
});
await page.goto(
  'file:///' +
    resolve('docs/research/packdetail/dramatic-grid.html').replace(/\\/g, '/'),
  { waitUntil: 'load' },
);
await page.waitForTimeout(1500);
await page.screenshot({
  path: 'docs/research/packdetail/dramatic-grid.png',
  fullPage: true,
});
await browser.close();
console.log('rendered 10 dramatic with grid');
