import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(2500);
await p.screenshot({
  path: 'docs/research/CLONE_NOW.png',
  clip: { x: 560, y: 60, width: 880, height: 470 },
});
const broken = await p.evaluate(
  () =>
    [...document.images].filter((x) => x.complete && x.naturalWidth === 0)
      .length,
);
console.log('ok broken=' + broken);
await b.close();
