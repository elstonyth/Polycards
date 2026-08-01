// Screenshot the 2026-08-01 boss fixes on the prod build (:4000):
//  1. /slots/bronze-pack — "Top hits" section (renamed, full scrollable rail,
//     no "Show all N rare cards" button)
//  2. signup modal — required phone field
//  3. /settings — name maxLength + phone hint (needs customer login)
// Run from repo root: node scripts/shot-boss-fixes.mjs
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const OUT = process.env.OUT_DIR ?? 'docs/research';
const BASE = process.env.PW_BASE ?? 'http://127.0.0.1:4000';

const env = Object.fromEntries(
  readFileSync('scripts/.dev-logins', 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [
      l.slice(0, l.indexOf('=')).trim(),
      l.slice(l.indexOf('=') + 1).trim(),
    ]),
);
const CUST_EMAIL = env.CUST_EMAIL ?? 'test@pokenic.app';
const CUST_PW = env.CUST_PW ?? '';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 420, height: 900 } });

// 1. Top hits section on the pack page (mobile viewport — boss reviews on phone)
await page.goto(`${BASE}/slots/bronze-pack`, { waitUntil: 'networkidle' });
const heading = page.getByRole('heading', { name: 'Top hits' });
await heading.scrollIntoViewIfNeeded();
await page.waitForTimeout(1200); // Reveal animation + images
await page.screenshot({ path: `${OUT}/top-hits-section.png` });
console.log('shot 1: top hits section');

// 2. Signup modal with required phone field
await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
const loginBtn = page
  .locator('header')
  .getByRole('button', { name: /^login$/i })
  .first();
await loginBtn.waitFor({ state: 'visible', timeout: 30000 });
await loginBtn.click();
await page.locator('input[name="email"]').waitFor({ state: 'visible' });
await page.getByRole('button', { name: 'Sign up' }).click();
await page.locator('input[name="phone"]').waitFor({ state: 'visible' });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/signup-phone.png` });
console.log('shot 2: signup phone field');

// 2b. invalid phone → inline error
await page.locator('input[name="username"]').fill('bibibo');
await page.locator('input[name="email"]').fill('demo@example.com');
await page.locator('input[name="phone"]').fill('12345');
await page.locator('input[name="password"]').fill('Password123!');
await page.locator('input[name="confirmPassword"]').fill('Password123!');
await page.getByRole('button', { name: 'Create account' }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/signup-phone-invalid.png` });
console.log('shot 2b: invalid phone error');

// 3. Settings (login as test customer via the same modal)
if (CUST_PW) {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await loginBtn.waitFor({ state: 'visible', timeout: 30000 });
  await loginBtn.click();
  const email = page.locator('input[name="email"]');
  await email.waitFor({ state: 'visible' });
  await email.fill(CUST_EMAIL);
  await page.fill('input[name="password"]', CUST_PW);
  await page.press('input[name="password"]', 'Enter');
  await email.waitFor({ state: 'detached', timeout: 15000 });
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/settings-limits.png` });
  console.log('shot 3: settings');
} else {
  console.log('shot 3 skipped: no CUST_PW');
}

await browser.close();
console.log('DONE');
