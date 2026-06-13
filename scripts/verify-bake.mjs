// Render the edited claw-machine webps (banner area) to confirm the seamless
// "phygitals"→"Pokenic" bake — no box, matched colour/alignment.
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { writeFileSync } from 'node:fs';

const bases = [
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
const W = 380;
// show each image but shift up so the banner (top ~12-26%) is framed
const cells = bases
  .map(
    (b) =>
      `<div style="margin:4px"><div style="font:11px monospace;color:#fff">${b}</div><div style="width:${W}px;height:${Math.round(W * 0.21)}px;overflow:hidden;background:#444"><img src="../../../public/images/claw/${b}-machine.webp" style="width:${W}px;margin-top:-${Math.round(W * (1000 / 1440) * 0.1)}px"/></div></div>`,
  )
  .join('');
writeFileSync(
  'docs/research/packdetail/verify-bake.html',
  `<!doctype html><body style="margin:0;background:#111;display:flex;flex-wrap:wrap">${cells}</body>`,
);

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 900 },
  deviceScaleFactor: 2,
});
await page.goto(
  'file:///' +
    resolve('docs/research/packdetail/verify-bake.html').replace(/\\/g, '/'),
  { waitUntil: 'load' },
);
await page.waitForTimeout(1500);
await page.screenshot({
  path: 'docs/research/packdetail/verify-bake.png',
  fullPage: true,
});
await browser.close();
console.log('rendered');
