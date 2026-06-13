import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto('http://localhost:4000/', { waitUntil: 'load', timeout: 60000 });
await p.waitForTimeout(1500);
// capture the hero across several rotations to see the glow follow the card
for (let i = 0; i < 6; i++) {
  await p.waitForTimeout(2800);
  await p.screenshot({
    path: `docs/research/glow_${i}.png`,
    clip: { x: 0, y: 0, width: 1920, height: 560 },
  });
}
const broken = await p.evaluate(
  () =>
    [...document.images].filter((x) => x.complete && x.naturalWidth === 0)
      .length,
);
console.log('broken:', broken, 'viewport: 1920x1080');
await b.close();
