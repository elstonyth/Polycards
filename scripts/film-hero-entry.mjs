import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = 'docs/research/hero-entry';
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:4000/how-it-works', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
// film first 1.4s of the hero entry
for (let f = 0; f < 14; f++) {
  await p.screenshot({
    path: `${OUT}/f${String(f).padStart(2, '0')}.png`,
    clip: { x: 0, y: 0, width: 1440, height: 600 },
  });
  await p.waitForTimeout(90);
}
console.log('filmed hero entry');
await b.close();
