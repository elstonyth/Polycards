import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:4000/', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});

await p.waitForTimeout(2500);
const d = await p.evaluate(() => {
  const h = [...document.querySelectorAll('h1,h2')].find((e) =>
    e.textContent.includes('Rip packs'),
  );
  const hero = h.closest('a') || h.parentElement.parentElement.parentElement;
  const hr = hero.getBoundingClientRect();
  // center pack (full opacity, biggest)
  const packs = [...document.querySelectorAll('img')]
    .filter((im) => /ripped-packs/.test(im.src))
    .map((im) => {
      const r = im.getBoundingClientRect();
      let w = im.parentElement,
        wc = getComputedStyle(w),
        dep = 0;
      while (w && dep < 4 && wc.opacity === '1') {
        w = w.parentElement;
        wc = getComputedStyle(w);
        dep++;
      }
      return {
        h: Math.round(r.height),
        w: Math.round(r.width),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
      };
    });
  const center = packs.sort((a, b) => b.h - a.h)[0];
  return {
    heroTop: Math.round(hr.top),
    heroH: Math.round(hr.height),
    heroBottom: Math.round(hr.bottom),
    centerPack: center,
  };
});
console.log('ORIGINAL:', JSON.stringify(d));
// pack bottom gap from hero bottom + pack height as % of hero height
console.log(
  'pack height % of hero:',
  ((d.centerPack.h / d.heroH) * 100).toFixed(1) + '%',
);
console.log(
  'gap pack-bottom to hero-bottom:',
  d.heroBottom - d.centerPack.bottom + 'px',
);
await b.close();
