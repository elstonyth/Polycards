// Verify-all sweep: every clone route at mobile->4K for horizontal overflow +
// broken images (natural size 0). Concrete, fast soundness check of the clone.
import { chromium } from 'playwright';

const BASE = 'http://localhost:4000';
const ROUTES = [
  '/',
  '/claw',
  '/claw/pokemon-mythic',
  '/marketplace',
  '/leaderboard',
  '/pack-party',
  '/how-it-works',
];
const WIDTHS = [390, 768, 1440, 1920, 2560, 3840];

const browser = await chromium.launch();
const report = [];
for (const route of ROUTES) {
  const row = { route, overflow: [], brokenImgs: 0 };
  for (const w of WIDTHS) {
    const ctx = await browser.newContext({
      viewport: { width: w, height: 900 },
      reducedMotion: 'reduce',
    });
    const page = await ctx.newPage();
    try {
      await page.goto(`${BASE}${route}`, {
        waitUntil: 'networkidle',
        timeout: 30000,
      });
      await page.waitForTimeout(500);
      const r = await page.evaluate(() => {
        const over =
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth;
        const broken = [...document.querySelectorAll('img')].filter(
          (i) => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.src),
        ).length;
        return { over, broken };
      });
      if (r.over > 1) row.overflow.push(`${w}:+${r.over}`);
      row.brokenImgs = Math.max(row.brokenImgs, r.broken);
    } catch (e) {
      row.overflow.push(`${w}:ERR`);
    }
    await ctx.close();
  }
  row.status =
    row.overflow.length === 0 && row.brokenImgs === 0 ? 'OK' : 'ISSUE';
  report.push(row);
}
await browser.close();
console.log(JSON.stringify(report, null, 2));
const allOk = report.every((r) => r.status === 'OK');
console.log(
  'VERDICT:',
  allOk ? 'PASS — no overflow / broken images on any route' : 'ISSUES found',
);
