// capture-shell-auth.mjs — logged-in shell QA: balance chip, top-up sheet, /me.
// Usage: node scripts/capture-shell-auth.mjs [baseUrl] [outDir]
// Uses the shared dev login (test@pokenic.app) against the local backend.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4000';
const OUT = process.argv[3] ?? 'tmp/shell-qa';
const EMAIL = process.env.PW_EMAIL ?? 'test@pokenic.app';
const PASSWORD = process.env.PW_PASSWORD ?? 'PokenicTest123!';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
const shot = (name) => page.screenshot({ path: path.join(OUT, name) });

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page
  .getByRole('button', { name: 'Accept' })
  .click({ timeout: 5000 })
  .catch(() => {});

// Log in through the AuthModal.
await page.getByRole('button', { name: 'Login' }).first().click();
await page.getByPlaceholder('Email').last().fill(EMAIL);
await page.getByPlaceholder('Password').fill(PASSWORD);
await page.keyboard.press('Enter');
// Balance chip appearing = login + balance fetch both worked.
await page
  .waitForSelector('text=/RM /', { timeout: 15000 })
  .catch(() => console.log('WARN: no RM balance chip after login'));
await page.waitForTimeout(1500);
await shot('auth-home-phone.png');

// Top-up sheet.
const chip = page.getByRole('button', { name: /top up/i }).first();
if (await chip.count()) {
  await chip.click();
  await page.waitForTimeout(600);
  await shot('auth-topup-sheet.png');
  await page.keyboard.press('Escape');
} else {
  console.log('WARN: balance chip not found');
}

// Me tab.
await page.goto(BASE + '/me', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});
await page.waitForTimeout(1500);
await shot('auth-me-phone.png');

// Daily + vault via tab bar (visual states while logged in).
await page.goto(BASE + '/vault', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});
await page.waitForTimeout(1500);
await shot('auth-vault-phone.png');

await page.goto(BASE + '/referrals', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});
await page.waitForTimeout(1500);
await shot('auth-referrals-phone.png');

await page.goto(BASE + '/leaderboard', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});
await page.waitForTimeout(1500);
await shot('auth-leaderboard-phone.png');

// Daily reward: capture claimable state, click Claim, capture claimed state.
await page.goto(BASE + '/daily', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});
await page.waitForTimeout(1500);
await shot('auth-daily-before.png');
const claimBtn = page.getByRole('button', { name: /^Claim RM/ });
if (await claimBtn.count()) {
  await claimBtn.click();
  await page.waitForTimeout(2500);
  await shot('auth-daily-after.png');
} else {
  console.log('NOTE: no claimable button (already claimed or paused)');
  await shot('auth-daily-after.png');
}

await browser.close();
console.log('done');
