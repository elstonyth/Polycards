import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = 'docs/playwright/hero-cf';
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(1500);
// capture 12 frames over ~9s to see rotation, cropped to right column
for (let f = 0; f < 12; f++) {
  await p.screenshot({
    path: `${OUT}/f${String(f).padStart(2, '0')}.png`,
    clip: { x: 600, y: 50, width: 840, height: 520 },
  });
  await p.waitForTimeout(750);
}
const broken = await p.evaluate(
  () =>
    [...document.images].filter((x) => x.complete && x.naturalWidth === 0)
      .length,
);
console.log('broken:', broken);
await b.close();
