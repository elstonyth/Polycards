import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = 'docs/research/hero-trans';
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

// High-FPS sample (every 120ms for ~12s) of EVERY hero img: full src, transform, opacity, x.
const samples = [];
for (let s = 0; s < 100; s++) {
  const snap = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')].filter((im) => {
      const r = im.getBoundingClientRect();
      return (
        r.top < 560 &&
        r.bottom > 0 &&
        r.width > 40 &&
        r.height > 40 &&
        r.x > 600
      );
    });
    return imgs.map((im) => {
      const cs = getComputedStyle(im);
      const r = im.getBoundingClientRect();
      const full = (im.currentSrc || im.src || '')
        .replace(/^https?:\/\/[^/]+/, '')
        .split('?')[0];
      return {
        f: full, // full path
        t: cs.transform === 'none' ? '' : cs.transform,
        o: cs.opacity,
        x: Math.round(r.x),
        rot: (cs.transform.match(/matrix\(([^)]+)\)/) || [])[1] || '',
      };
    });
  });
  samples.push({ i: s, imgs: snap });
  await page.waitForTimeout(120);
}
fs.writeFileSync(`${OUT}/hifps.json`, JSON.stringify(samples));

// Detect transition windows: when the set of full src paths on the right changes
let prev = '';
const changes = [];
samples.forEach((s) => {
  const key = s.imgs
    .map((i) => i.f)
    .sort()
    .join(',');
  if (key !== prev) {
    changes.push(s.i);
    prev = key;
  }
});
console.log('src-set changed at sample indices:', changes.join(','));
// print the distinct full paths seen
const all = new Set();
samples.forEach((s) => s.imgs.forEach((i) => all.add(i.f)));
console.log('DISTINCT PATHS:');
[...all].forEach((p) => console.log('  ' + p));

// Around the first change, dump transforms to see HOW it transitions
const c = changes[1];
if (c != null) {
  console.log(`\n=== transition window around sample ${c} ===`);
  for (
    let j = Math.max(0, c - 3);
    j <= Math.min(samples.length - 1, c + 3);
    j++
  ) {
    console.log(
      's' +
        j +
        ': ' +
        samples[j].imgs
          .map(
            (i) =>
              `${i.f.split('/').slice(-2).join('/')} x${i.x} o${i.o} ${i.t.slice(0, 30)}`,
          )
          .join(' | '),
    );
  }
}
await browser.close();
