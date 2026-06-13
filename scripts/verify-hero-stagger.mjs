import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
// Load page; hero is at top, so Reveal elements animate on mount. Sample opacity right at load (should be mid-animation/low) then after.
await p.goto('http://localhost:4000/how-it-works', {
  waitUntil: 'domcontentloaded',
  timeout: 60000,
});
// capture very early
await p.waitForTimeout(80);
const early = await p.evaluate(() => {
  const grab = (sel) => {
    const e = [...document.querySelectorAll(sel)][0];
    return e ? +(+getComputedStyle(e).opacity).toFixed(2) : null;
  };
  return {
    eyebrow: grab('section p'),
    h1: grab('section h1'),
    pack: (() => {
      const i = [...document.images].find((x) =>
        x.src.includes('ripped-packs/pokemon'),
      );
      return i
        ? +(+getComputedStyle(i.closest('div')).opacity).toFixed(2)
        : null;
    })(),
  };
});
await p.waitForTimeout(1600);
const late = await p.evaluate(() => {
  const grab = (sel) => {
    const e = [...document.querySelectorAll(sel)][0];
    return e ? +(+getComputedStyle(e).opacity).toFixed(2) : null;
  };
  const broken = [...document.images].filter(
    (i) => i.complete && i.naturalWidth === 0,
  ).length;
  return { eyebrow: grab('section p'), h1: grab('section h1'), broken };
});
console.log('EARLY (≈80ms, mid-stagger):', JSON.stringify(early));
console.log('LATE  (settled):           ', JSON.stringify(late));
console.log(
  'VERDICT:',
  early.h1 !== null && early.h1 < 1 && late.h1 === 1
    ? 'PASS — hero elements animate in'
    : 'check (may have settled too fast)',
);
await b.close();
