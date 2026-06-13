import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(2500);
// full hero banner (top portion of page)
await p.screenshot({
  path: 'docs/research/CLONE_HERO_FULL.png',
  clip: { x: 0, y: 90, width: 1440, height: 420 },
});
const g = await p.evaluate(() => {
  const a = document.querySelector('section a');
  const r = a.getBoundingClientRect();
  return { h: Math.round(r.height), w: Math.round(r.width) };
});
console.log('clone container:', JSON.stringify(g));
await b.close();
