import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = 'docs/research/hero-compare';
fs.mkdirSync(OUT, { recursive: true });
const b = await chromium.launch();
const clip = { x: 560, y: 60, width: 880, height: 470 };

// ORIGINAL: grab a stable mid-cycle frame
const op = await b.newPage({ viewport: { width: 1440, height: 900 } });
await op.goto('https://www.phygitals.com/', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
for (let i = 0; i < 25; i++) {
  if (await op.evaluate(() => document.images.length > 5)) break;
  await op.waitForTimeout(1000);
}
await op.waitForTimeout(3500);
await op.screenshot({ path: `${OUT}/ORIGINAL.png`, clip });
// measure side vs center card geometry on the original
const oGeo = await op.evaluate(() => {
  const imgs = [...document.querySelectorAll('img')].filter((im) => {
    const r = im.getBoundingClientRect();
    return (
      r.top < 560 &&
      r.x > 560 &&
      r.width > 60 &&
      r.height > 60 &&
      /ripped-packs|slabs/.test(im.src)
    );
  });
  return imgs
    .map((im) => {
      const r = im.getBoundingClientRect();
      const cs = getComputedStyle(im);
      let w = im.parentElement,
        wc = getComputedStyle(w),
        d = 0;
      while (w && d < 4 && wc.transform === 'none') {
        w = w.parentElement;
        wc = getComputedStyle(w);
        d++;
      }
      return {
        src: im.src.split('/').pop(),
        cx: Math.round(r.x + r.width / 2),
        top: Math.round(r.top),
        w: Math.round(r.width),
        op: +(+cs.opacity).toFixed(2),
        wT: wc.transform.slice(0, 40),
        wOp: +(+wc.opacity).toFixed(2),
        blur: (cs.filter.match(/blur\(([\d.]+)/) || [])[1] || '0',
      };
    })
    .sort((a, b) => a.cx - b.cx);
});
console.log('=== ORIGINAL card geometry (sorted by x) ===');
oGeo.forEach((g) =>
  console.log(
    `  ${g.src.padEnd(18)} cx=${g.cx} top=${g.top} w=${g.w} imgOp=${g.op} wrapOp=${g.wOp} blur=${g.blur}`,
  ),
);
await op.close();

// CLONE
const cp = await b.newPage({ viewport: { width: 1440, height: 900 } });
await cp.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await cp.waitForTimeout(2000);
await cp.screenshot({ path: `${OUT}/CLONE.png`, clip });
await cp.close();
await b.close();
console.log('saved ORIGINAL.png + CLONE.png');
