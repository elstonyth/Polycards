#!/usr/bin/env node
// UI check for the two-step top-up sheet: choose a currency, then only that
// currency's form. Mobile viewport; screenshots -> docs/research/topup-*.png.
//
//   STORE=http://127.0.0.1:4100 node scripts/qa-topup-currency.mjs
//
// Needs a storefront built with NEXT_PUBLIC_PAYMENTS_PROVIDER set (real-gateway
// path), a backend whose /store/payments/config lists the SGD rail, and the
// gitignored scripts/.dev-logins (CUST_PW).
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const STORE = process.env.STORE ?? 'http://127.0.0.1:4000';
const OUT = new URL('../docs/research/', import.meta.url).pathname.replace(
  /^\/(\w:)/,
  '$1',
);
const logins = Object.fromEntries(
  // DEV_LOGINS lets a worktree read the main checkout's gitignored file.
  readFileSync(
    process.env.DEV_LOGINS ?? new URL('./.dev-logins', import.meta.url),
    'utf8',
  )
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
);

let failures = 0;
const check = (name, cond, detail = '') => {
  if (!cond) failures += 1;
  console.log(
    `${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`,
  );
};

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

for (let i = 0; i < 4; i += 1) {
  try {
    await page.goto(`${STORE}/`, { waitUntil: 'domcontentloaded' });
    const btn = page
      .locator('header')
      .getByRole('button', { name: /^login$/i })
      .first();
    await btn.waitFor({ timeout: 60000 });
    await btn.click();
    const email = page.locator('input[name="email"]');
    await email.waitFor({ timeout: 20000 });
    await email.fill(logins.CUST_EMAIL || 'test@pokenic.app');
    await page.fill('input[name="password"]', logins.CUST_PW);
    await page.press('input[name="password"]', 'Enter');
    await email.waitFor({ state: 'detached', timeout: 15000 });
    break;
  } catch {
    await page.waitForTimeout(3000);
  }
}

await page.goto(`${STORE}/me`);
// A test account without a real name gets the full-screen real-name prompt
// (inside <main>). This script checks the top-up sheet only, so hide it for
// the run instead of writing a real name onto the shared test account.
await page.waitForTimeout(1500);
await page.addStyleTag({
  content: 'main .glass-stage.fixed.inset-0 { display: none !important; }',
});
await page.locator('header button[aria-label*="top up" i]').first().click();
const sheet = page.getByRole('dialog', { name: 'Top up credits' });
await sheet.waitFor();
await page.waitForTimeout(1500);

// Step 1: the currency list only.
check(
  'opens on "Choose a currency"',
  await sheet.getByText('Choose a currency').isVisible(),
);
check(
  'no amount field before a currency is chosen',
  (await sheet.locator('input[aria-label^="Top-up amount"]').count()) === 0,
);
const sgdRow = sheet.getByRole('button', { name: /Singapore Dollar/ });
check(
  'lists RM and S$',
  (await sheet
    .getByRole('button', { name: /Malaysian Ringgit/ })
    .isVisible()) && (await sgdRow.isVisible()),
  await sgdRow.innerText().catch(() => ''),
);
await page.screenshot({ path: `${OUT}topup-step1-currency.png` });

// Step 2a: S$ form only.
await sgdRow.click();
await page.waitForTimeout(400);
check(
  'S$ form: S$ amount field',
  await sheet.getByLabel('Top-up amount in S$').isVisible(),
);
check(
  'S$ form: payer name + PayNow',
  (await sheet.getByText('Name on your bank account').isVisible()) &&
    (await sheet.getByText('PayNow QR').isVisible()),
);
check(
  'S$ form: no currency list',
  !(await sheet.getByText('Choose a currency').isVisible()),
);
check(
  'amount field has focus after choosing',
  await sheet
    .getByLabel('Top-up amount in S$')
    .evaluate((el) => el === document.activeElement),
);
await page.screenshot({ path: `${OUT}topup-step2-sgd.png` });

// Back, then the RM form only.
await sheet.getByRole('button', { name: 'Change' }).click();
check(
  'Change returns to the list',
  await sheet.getByText('Choose a currency').isVisible(),
);
await sheet.getByRole('button', { name: /Malaysian Ringgit/ }).click();
await page.waitForTimeout(400);
check(
  'RM form: RM amount field, no payer name',
  (await sheet.getByLabel('Top-up amount in RM').isVisible()) &&
    !(await sheet.getByText('Name on your bank account').isVisible()),
);
await page.screenshot({ path: `${OUT}topup-step2-rm.png` });

await browser.close();
console.log(
  failures ? `${failures} FAILED` : 'all currency-step checks passed',
);
process.exit(failures ? 1 : 0);
