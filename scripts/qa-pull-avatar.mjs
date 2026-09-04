import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://127.0.0.1:4000';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const fails = [];

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
const feed = page.locator('section[aria-labelledby="recent-pulls-heading"]');
await feed.scrollIntoViewIfNeeded();
const avatar = feed.locator('a[aria-label*="activity"]').first();
await avatar.waitFor({ timeout: 15000 });
console.log('avatar link label:', await avatar.getAttribute('aria-label'));
console.log('avatar href:', await avatar.getAttribute('href'));

await avatar.click();
await page.waitForURL(/\/profile\//, { timeout: 15000 });
console.log('after avatar click:', page.url());
if (!/\?tab=activity/.test(page.url()))
  fails.push('avatar did not carry ?tab=activity');
const activeTab = (
  await page.locator('button[aria-pressed="true"]').first().innerText()
).trim();
console.log('active profile tab:', activeTab);
if (activeTab !== 'Activity')
  fails.push(`profile opened on "${activeTab}", not Activity`);
await page.screenshot({ path: 'docs/research/qa-pull-avatar-profile.png' });

await page.goBack({ waitUntil: 'domcontentloaded' });
const row = feed.locator('a[aria-label*="pulled"]').first();
await row.scrollIntoViewIfNeeded();
await row.click();
await page.waitForURL(/\/card\//, { timeout: 15000 });
console.log('after row click:', page.url());

await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
await feed.scrollIntoViewIfNeeded();
await page.waitForTimeout(1500);
await feed.screenshot({ path: 'docs/research/qa-pull-avatar-feed.png' });

const nested = await feed.evaluate(
  (el) =>
    [...el.querySelectorAll('a a, a button, button a, button button')].length,
);
console.log('nested interactive count:', nested);
if (nested > 0) fails.push(`${nested} nested interactive elements`);

await browser.close();
console.log(fails.length ? `FAIL\n- ${fails.join('\n- ')}` : 'PASS');
process.exit(fails.length ? 1 : 0);
