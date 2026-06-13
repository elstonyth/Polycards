// Batch capture LIVE (phygitals.com) vs CLONE (localhost:4000) for every route at 1440,
// full-height via the tall-viewport trick (handles the live site's inner main.flex-1 scroller
// AND fires the clone's scroll-reveal sections so nothing captures blank).
// Output: docs/research/gap/<LIVE|CLONE>_<name>.png
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'docs/research/gap';
mkdirSync(OUT, { recursive: true });

const ROUTES = [
  '/',
  '/claw',
  '/pack-party',
  '/marketplace',
  '/leaderboard',
  '/how-it-works',
];
const nameOf = (r) =>
  r === '/' ? 'home' : r.replace(/\//g, '').replace(/-/g, '');

const browser = await chromium.launch();

async function shoot(base, prefix, route) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  const name = nameOf(route);
  try {
    await page
      .goto(base + route, { waitUntil: 'networkidle', timeout: 45000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
    // Measure the tallest content height (document, body, or inner main scroller)
    const h = await page.evaluate(() => {
      const main = document.querySelector('main');
      const c = [
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
      ];
      if (main) c.push(main.scrollHeight);
      return Math.min(Math.max(Math.max(...c) + 120, 1000), 16000);
    });
    await page.setViewportSize({ width: 1440, height: h });
    await page.waitForTimeout(2000); // let lazy images + reveals settle
    await page.screenshot({ path: `${OUT}/${prefix}_${name}.png` });
    console.log('OK  ', prefix, name, `(h=${h})`);
  } catch (e) {
    console.log('FAIL', prefix, name, e.message);
  }
  await ctx.close();
}

for (const r of ROUTES) {
  await shoot('https://www.phygitals.com', 'LIVE', r);
  await shoot('http://localhost:4000', 'CLONE', r);
}
await browser.close();
console.log('done');
