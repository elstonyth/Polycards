import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(2500);
await p.screenshot({
  path: 'docs/research/CLONE_HERO_DONE.png',
  clip: { x: 0, y: 0, width: 1440, height: 560 },
});
const broken = await p.evaluate(
  () =>
    [...document.images].filter((x) => x.complete && x.naturalWidth === 0)
      .length,
);
console.log('broken:', broken);
await b.close();
