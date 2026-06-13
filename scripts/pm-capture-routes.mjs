// Capture top-of-page (hero) for the directly-comparable primary routes on
// ORIG (phygitals.com) vs CLONE (localhost:4000) at 1440. Find the bigger gaps.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = 'docs/research/pixelmatch/routes';
mkdirSync(OUT, { recursive: true });

const ROUTES = [
  '/marketplace',
  '/leaderboard',
  '/how-it-works',
  '/pack-party',
  '/claw',
];
const ORIGIN = {
  ORIG: 'https://www.phygitals.com',
  CLONE: 'http://localhost:4000',
};

const browser = await chromium.launch();
const log = [];

for (const route of ROUTES) {
  const slug = route.replace(/^\//, '').replace(/\//g, '_');
  for (const [site, origin] of Object.entries(ORIGIN)) {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 1024 },
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    try {
      const resp = await page.goto(origin + route, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
      for (let i = 0; i < 20; i++) {
        const r = await page
          .evaluate(() => document.images.length > 2)
          .catch(() => false);
        if (r) break;
        await page.waitForTimeout(500);
      }
      await page.waitForTimeout(1800);
      await page.screenshot({ path: `${OUT}/${site}_${slug}.png` });
      log.push(
        `${site.padEnd(6)} ${route.padEnd(16)} http=${resp ? resp.status() : '?'}`,
      );
    } catch (e) {
      log.push(`${site} ${route} FAIL ${e.message}`);
    }
    await ctx.close();
  }
}
await browser.close();
console.log(log.join('\n'));
console.log('done');
