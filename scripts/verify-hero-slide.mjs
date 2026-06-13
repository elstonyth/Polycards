import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = 'docs/playwright/hero-slide';
fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto('http://localhost:4000/', {
  waitUntil: 'load',
  timeout: 60000,
});
await page.waitForTimeout(1500);
// sample the carousel track translateX + which pack is centered over ~9s
const samples = [];
for (let s = 0; s < 18; s++) {
  const snap = await page.evaluate(() => {
    const track = [...document.querySelectorAll('div')].find(
      (d) => d.style.transform && d.style.transform.includes('translateX'),
    );
    const packs = [...document.querySelectorAll('img')].filter(
      (i) =>
        (i.src || '').includes('ripped-packs') && !i.className.includes('blur'),
    );
    // which pack is horizontally centered (x near 1080-ish in right column)?
    const centered = packs
      .map((i) => {
        const r = i.getBoundingClientRect();
        return {
          n: i.alt,
          cx: Math.round(r.x + r.width / 2),
          op: getComputedStyle(i).opacity,
        };
      })
      .filter((p) => p.cx > 720 && p.cx < 1440)
      .sort((a, b) => Math.abs(a.cx - 1100) - Math.abs(b.cx - 1100));
    return {
      track: track ? track.style.transform : null,
      centered: centered[0] ? centered[0].n : null,
    };
  });
  samples.push(snap);
  await page.waitForTimeout(500);
}
fs.writeFileSync(`${OUT}/slide-samples.json`, JSON.stringify(samples, null, 1));
samples.forEach((s, i) =>
  console.log(
    's' +
      String(i).padStart(2) +
      ': track=' +
      s.track +
      ' centered=' +
      s.centered,
  ),
);
// capture a few frames during one transition
for (let f = 0; f < 8; f++) {
  await page.screenshot({
    path: `${OUT}/f${f}.png`,
    clip: { x: 700, y: 60, width: 740, height: 520 },
  });
  await page.waitForTimeout(180);
}
const broken = await page.evaluate(
  () =>
    [...document.images].filter((x) => x.complete && x.naturalWidth === 0)
      .length,
);
console.log('broken:', broken);
await browser.close();
