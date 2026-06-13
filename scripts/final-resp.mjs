import { chromium } from 'playwright';
const b = await chromium.launch();
for (const w of [390, 768, 1440, 1920, 3840]) {
  const p = await b.newPage({ viewport: { width: w, height: 900 } });
  await p.goto('http://localhost:4000/how-it-works', {
    waitUntil: 'load',
    timeout: 60000,
  });
  await p.waitForTimeout(900);
  const r = await p.evaluate(() => ({
    overflowX: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    broken: [...document.images].filter(
      (i) => i.complete && i.naturalWidth === 0,
    ).length,
  }));
  console.log(`[${w}] overflowX=${r.overflowX} broken=${r.broken}`);
  await p.close();
}
await b.close();
