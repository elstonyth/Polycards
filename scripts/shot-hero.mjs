import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(2000);
await p.screenshot({
  path: 'docs/research/HERO_LOWER.png',
  clip: { x: 0, y: 56, width: 1920, height: 560 },
});
const broken = await p.evaluate(
  () =>
    [...document.images].filter((x) => x.complete && x.naturalWidth === 0)
      .length,
);
console.log('broken:', broken);
await b.close();
