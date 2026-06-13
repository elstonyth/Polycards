import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = 'docs/research/hero-orig';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('https://www.phygitals.com/', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
for (let i = 0; i < 25; i++) {
  if (await page.evaluate(() => document.querySelectorAll('img').length > 5))
    break;
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(2500);

// Capture top 560px every 250ms for ~8s
for (let f = 0; f < 32; f++) {
  await page.screenshot({
    path: `${OUT}/f${String(f).padStart(2, '0')}.png`,
    clip: { x: 0, y: 0, width: 1440, height: 560 },
  });
  await page.waitForTimeout(250);
}

// Sample every img's full transform + position in the hero over ~10s
const samples = [];
for (let s = 0; s < 20; s++) {
  const snap = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')].filter((im) => {
      const r = im.getBoundingClientRect();
      return r.top < 560 && r.bottom > 0 && r.width > 30 && r.height > 30;
    });
    return imgs.map((im) => {
      const cs = getComputedStyle(im);
      const r = im.getBoundingClientRect();
      return {
        src: (im.currentSrc || im.src || '')
          .replace(/^https?:\/\/[^/]+/, '')
          .split('?')[0]
          .split('/')
          .pop(),
        transform: cs.transform,
        opacity: cs.opacity,
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
        cls: (im.className || '').toString().slice(0, 70),
      };
    });
  });
  samples.push(snap);
  await page.waitForTimeout(500);
}
fs.writeFileSync(`${OUT}/samples.json`, JSON.stringify(samples, null, 1));
console.log(
  'DONE. samples=' +
    samples.length +
    ' imgs/sample=' +
    samples.map((s) => s.length).join(','),
);
await browser.close();
