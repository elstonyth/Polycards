import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1000 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(2000);
await p.screenshot({
  path: 'docs/research/CLONE_WIDE_1920.png',
  clip: { x: 0, y: 0, width: 1920, height: 560 },
});
// measure hero at 1920
const d = await p.evaluate(() => {
  const a = [...document.querySelectorAll('a')].find((el) => {
    const r = el.getBoundingClientRect();
    return (
      r.top < 200 &&
      r.width > 900 &&
      r.height >= 400 &&
      getComputedStyle(el).borderRadius !== '0px'
    );
  });
  const r = a.getBoundingClientRect();
  return {
    x: Math.round(r.x),
    w: Math.round(r.width),
    right: Math.round(r.right),
  };
});
console.log('hero @1920:', JSON.stringify(d), 'viewport=1920');
await b.close();
