import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('https://www.phygitals.com/', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
for (let i = 0; i < 25; i++) {
  if (await p.evaluate(() => document.images.length > 5)) break;
  await p.waitForTimeout(1000);
}
await p.waitForTimeout(3000);
await p.screenshot({
  path: 'docs/research/ORIG_HERO_FULL.png',
  clip: { x: 0, y: 90, width: 1440, height: 420 },
});
await b.close();
console.log('orig hero captured');
