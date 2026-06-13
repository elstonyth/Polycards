import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = 'docs/research/hero-film';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const b = await chromium.launch();
const page = await b.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
await page.goto('https://www.phygitals.com/', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
for (let i = 0; i < 25; i++) {
  if (await page.evaluate(() => document.querySelectorAll('img').length > 5))
    break;
  await page.waitForTimeout(1000);
}
await page.waitForTimeout(3000);

// Hero clip = top region, right half where cards live
const clip = { x: 560, y: 60, width: 880, height: 470 };

// FILM: 80 frames @ ~110ms = ~9s, covering ~3 full rotations (theme swaps every ~2-3s)
const meta = [];
for (let f = 0; f < 80; f++) {
  await page.screenshot({
    path: `${OUT}/frame_${String(f).padStart(3, '0')}.png`,
    clip,
  });
  // record positions/opacity/transform/filter of every hero card img + the bg glow element
  const m = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')]
      .filter((im) => {
        const r = im.getBoundingClientRect();
        return (
          r.top < 560 &&
          r.bottom > 40 &&
          r.x > 560 &&
          r.width > 50 &&
          r.height > 50
        );
      })
      .map((im) => {
        const cs = getComputedStyle(im);
        const r = im.getBoundingClientRect();
        // climb to the positioned ancestor that carries the transform/opacity (the slot wrapper)
        let wrap = im.parentElement,
          wcs = getComputedStyle(wrap),
          depth = 0;
        while (
          wrap &&
          depth < 4 &&
          wcs.transform === 'none' &&
          wcs.opacity === '1'
        ) {
          wrap = wrap.parentElement;
          wcs = getComputedStyle(wrap);
          depth++;
        }
        return {
          src: (im.currentSrc || im.src || '').split('/').pop().split('?')[0],
          cx: Math.round(r.x + r.width / 2),
          w: Math.round(r.width),
          h: Math.round(r.height),
          op: +(+cs.opacity).toFixed(2),
          wrapOp: +(+wcs.opacity).toFixed(2),
          wrapT: wcs.transform === 'none' ? '' : wcs.transform,
          filter:
            cs.filter === 'none'
              ? wcs.filter === 'none'
                ? ''
                : wcs.filter
              : cs.filter,
        };
      });
    // background glow: any element with a radial-gradient or large blur near hero
    const glow = [...document.querySelectorAll('*')]
      .filter((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return (
          r.top < 560 &&
          r.width > 300 &&
          (/radial-gradient|linear-gradient/.test(cs.backgroundImage) ||
            parseFloat(cs.filter.replace(/[^\d.]/g, '')) > 20 ||
            cs.filter.includes('blur'))
        );
      })
      .slice(0, 3)
      .map((el) => {
        const cs = getComputedStyle(el);
        return {
          bg: (cs.backgroundImage || '').slice(0, 80),
          filter: cs.filter,
          op: +(+cs.opacity).toFixed(2),
        };
      });
    return { imgs, glow };
  });
  meta.push({ f, ...m });
  await page.waitForTimeout(110);
}
fs.writeFileSync(`${OUT}/meta.json`, JSON.stringify(meta));
console.log('FILMED', meta.length, 'frames');

// Build a compact timeline: per frame, list each unique card's center-x + opacity, sorted by cx
const lines = meta.map((s) => {
  const cards = s.imgs.filter(
    (i) => i.src.includes('ripped-packs') || i.src.includes('slabs'),
  );
  // group by theme (strip slab/pack distinction)
  const byTheme = {};
  cards.forEach((c) => {
    const t = c.src.replace(/\.webp$/, '').replace(/[0-9]+$/, '');
    (byTheme[t] ||= []).push(c);
  });
  const summary = Object.entries(byTheme).map(([t, cs]) => {
    const cx = Math.round(cs.reduce((a, c) => a + c.cx, 0) / cs.length);
    const op = Math.max(...cs.map((c) => c.wrapOp));
    const blur = cs.find((c) => /blur\(([\d.]+)/.test(c.filter));
    const bv = blur ? (blur.filter.match(/blur\(([\d.]+)/) || [])[1] : '0';
    return `${t}:x${cx}/o${op}/b${bv}`;
  });
  return `f${String(s.f).padStart(2)} ${summary.join('  ')}`;
});
fs.writeFileSync(`${OUT}/timeline.txt`, lines.join('\n'));
console.log(lines.slice(0, 40).join('\n'));
await b.close();
