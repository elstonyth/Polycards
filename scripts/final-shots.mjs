import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
// HOME: scroll to OpenPacks + Community to confirm Reveal wrapper didn't break layout
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(1000);
await p.evaluate(() => {
  const h = [...document.querySelectorAll('h2')].find(
    (e) => e.textContent.trim() === 'Open Packs',
  );
  h && h.scrollIntoView({ block: 'start' });
});
await p.waitForTimeout(1000);
await p.screenshot({
  path: 'docs/research/FINAL_home_openpacks.png',
  clip: { x: 0, y: 0, width: 1440, height: 760 },
});
// HIW page top
await p.goto('http://localhost:4000/how-it-works', {
  waitUntil: 'load',
  timeout: 60000,
});
await p.waitForTimeout(1200);
await p.screenshot({
  path: 'docs/research/FINAL_hiw_top.png',
  clip: { x: 0, y: 0, width: 1440, height: 760 },
});
const broken = await p.evaluate(
  () =>
    [...document.images].filter((i) => i.complete && i.naturalWidth === 0)
      .length,
);
console.log('hiw broken:', broken);
await b.close();
