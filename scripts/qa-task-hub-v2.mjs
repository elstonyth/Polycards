// QA capture of the /task hub v2 (daily tasks, prize art, check-in track,
// claimable sparkle — spec 2026-10-06). Seeds the session cookie directly
// (PW_JWT) instead of driving the login form, so it works against any
// backend that answers /store/tasks for that token — including a fixture
// server for a design preview.
// Usage:
//   PW_BASE=http://localhost:4100 PW_JWT=<customer jwt> node scripts/qa-task-hub-v2.mjs
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://localhost:4100';
const JWT = process.env.PW_JWT ?? 'preview';
const OUT = process.env.PW_OUT ?? 'docs/research';

const browser = await chromium.launch();

async function capture(viewport, suffix) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const { hostname } = new URL(BASE);
  await ctx.addCookies([
    { name: '_polycards_jwt', value: JWT, domain: hostname, path: '/' },
  ]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/task`, { waitUntil: 'networkidle' });
  const reject = page.getByRole('button', { name: /reject/i });
  if (await reject.count())
    await reject
      .first()
      .click()
      .catch(() => {});
  // The floating community banner would sit over the rows in every shot.
  const tg = page.getByRole('button', { name: /dismiss telegram banner/i });
  if (await tg.count())
    await tg
      .first()
      .click()
      .catch(() => {});
  await page.waitForTimeout(1500); // images + one twinkle cycle in

  for (const [tab, file] of [
    [/^daily/i, 'daily'],
    [/^weekly/i, 'weekly'],
    [/^achievements/i, 'achievements'],
  ]) {
    // force: claimable rows animate forever, so Playwright's stability
    // check would never settle on the page.
    await page.getByRole('button', { name: tab }).click({ force: true });
    await page.waitForTimeout(900);
    // The page's own content only: a full-page shot pins the fixed header
    // and tab bar over the middle of the list.
    await page.locator('main').screenshot({
      path: `${OUT}/task-hub-v2-${file}-${suffix}.png`,
      style: '[data-site-chrome] { visibility: hidden !important; }',
    });
  }
  // And the real thing: what a phone shows on landing, chrome included.
  await page.getByRole('button', { name: /^daily/i }).click({ force: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/task-hub-v2-viewport-${suffix}.png` });
  await ctx.close();
}

await capture({ width: 390, height: 844 }, 'mobile');
await capture({ width: 1280, height: 900 }, 'desktop');
console.log('captured 8 screenshots');
await browser.close();
