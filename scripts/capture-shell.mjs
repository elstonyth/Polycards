// capture-shell.mjs — screenshot the new app shell (Phase 0 QA).
// Usage: node scripts/capture-shell.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4000';
const OUT = process.argv[3] ?? 'tmp/shell-qa';
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: 'phone', width: 390, height: 844 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];
const ROUTES = [
  { name: 'home', path: '/' },
  { name: 'daily', path: '/daily' },
  { name: 'leaderboard', path: '/leaderboard' },
];

const browser = await chromium.launch();
for (const vp of VIEWPORTS) {
  const ctx = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  });
  const page = await ctx.newPage();
  // Dismiss the cookie banner once per context so the tab bar is visible.
  await page.goto(BASE + '/', {
    waitUntil: 'domcontentloaded',
    timeout: 20000,
  });
  await page
    .getByRole('button', { name: 'Accept' })
    .click({ timeout: 5000 })
    .catch(() => {});
  for (const route of ROUTES) {
    try {
      await page.goto(BASE + route.path, {
        waitUntil: 'domcontentloaded',
        timeout: 20000,
      });
      await page.waitForTimeout(1500);
      const file = path.join(OUT, `${route.name}-${vp.name}.png`);
      await page.screenshot({ path: file });
      console.log('ok', file);
    } catch (err) {
      console.log('FAIL', route.path, vp.name, String(err).slice(0, 200));
    }
  }
  await ctx.close();
}
await browser.close();
