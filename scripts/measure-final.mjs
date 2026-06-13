import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(2500);
const d = await p.evaluate(() => {
  const a = document.querySelector('section a');
  const r = a.getBoundingClientRect();
  const imgs = [...document.querySelectorAll('img')].filter((im) => {
    const rr = im.getBoundingClientRect();
    return rr.x > 560 && rr.width > 60 && /ripped-packs/.test(im.src);
  });
  const center = imgs
    .map((im) => {
      const rr = im.getBoundingClientRect();
      let w = im.parentElement,
        wc = getComputedStyle(w),
        dd = 0;
      while (w && dd < 4 && wc.transform === 'none') {
        w = w.parentElement;
        wc = getComputedStyle(w);
        dd++;
      }
      return {
        h: Math.round(rr.height),
        w: Math.round(rr.width),
        wOp: +(+wc.opacity).toFixed(2),
      };
    })
    .filter((c) => c.wOp > 0.9)
    .sort((a, b) => b.h - a.h)[0];
  return { container: { h: Math.round(r.height) }, centerCard: center };
});
console.log(
  'CLONE container.h=' +
    d.container.h +
    '  centerCard h=' +
    d.centerCard.h +
    ' w=' +
    d.centerCard.w,
);
console.log('(ORIGINAL target: container.h=480  centerCard h=400 w=251)');
await p.screenshot({
  path: 'docs/research/CLONE_HERO_FULL.png',
  clip: { x: 0, y: 90, width: 1440, height: 420 },
});
await b.close();
