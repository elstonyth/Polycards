// Screenshot the new bulk "Remove from pack" flow in the admin pack editor.
// Run from repo root: node <path>/shot-bulk-remove.mjs
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const OUT = process.env.OUT_DIR ?? '.';
const ADMIN = 'http://localhost:7000/dashboard';

// creds from gitignored scripts/.dev-logins (KEY=VALUE)
const env = Object.fromEntries(
  readFileSync('scripts/.dev-logins', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [
      l.slice(0, l.indexOf('=')).trim(),
      l.slice(l.indexOf('=') + 1).trim(),
    ]),
);
const EMAIL = env.ADMIN_EMAIL ?? 'admin@pokenic.app';
const PW = env.ADMIN_PW ?? '';
if (!PW) throw new Error('ADMIN_PW missing in scripts/.dev-logins');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

// login
await page.goto(`${ADMIN}/login`, { waitUntil: 'domcontentloaded' });
const email = page.locator('input[name="email"]');
await email.waitFor({ state: 'visible', timeout: 30000 });
await email.fill(EMAIL);
await page.fill('input[name="password"]', PW);
await page.keyboard.press('Enter');
await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 20000 });
console.log('admin logged in');

// pack list -> first pack editor
await page.goto(`${ADMIN}/packs`, { waitUntil: 'domcontentloaded' });
const firstRowLink = page.locator('table a[href*="/packs/"]').first();
let slugUrl;
if (await firstRowLink.count()) {
  slugUrl = await firstRowLink.getAttribute('href');
  await firstRowLink.click();
} else {
  // rows may navigate on click instead of carrying <a>
  await page.locator('table tbody tr').first().click();
}
await page.waitForTimeout(1500);
console.log('editor url:', page.url());

// wait for odds table rows, check first 3 row checkboxes (skip header select-all)
const rowChecks = page.locator(
  'table tbody [role="checkbox"], table tbody input[type="checkbox"]',
);
await rowChecks.first().waitFor({ state: 'visible', timeout: 30000 });
const n = Math.min(3, await rowChecks.count());
for (let i = 0; i < n; i++) await rowChecks.nth(i).click();
await page.waitForTimeout(400);

// bulk bar visible with Remove button
const removeBtn = page.getByRole('button', { name: 'Remove from pack' });
await removeBtn.waitFor({ state: 'visible', timeout: 10000 });
await page.screenshot({ path: `${OUT}/bulk-bar.png`, fullPage: false });
console.log('shot 1: bulk bar');

// open confirm dialog, screenshot, cancel (no actual removal)
await removeBtn.click();
await page
  .getByRole('button', { name: 'Remove', exact: true })
  .waitFor({ state: 'visible', timeout: 10000 });
await page.waitForTimeout(300);
await page.screenshot({
  path: `${OUT}/bulk-remove-confirm.png`,
  fullPage: false,
});
console.log('shot 2: confirm dialog');
await page.getByRole('button', { name: 'Cancel', exact: true }).click();

await browser.close();
console.log('DONE');
