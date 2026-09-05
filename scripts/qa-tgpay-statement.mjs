// Statement smoke (plan 130): log the dev customer in on the prod storefront,
// open /transactions and /wallet, screenshot both to docs/research/, and print
// the gateway method/status line rendered under each money row's reference.
//
//   node scripts/qa-tgpay-statement.mjs        # STORE_BASE defaults to :4000

import { chromium } from '@playwright/test';
import path from 'node:path';
import { devCustomer } from './lib/dev-logins.mjs';

const STORE = process.env.STORE_BASE ?? 'http://127.0.0.1:4000';
const OUT = path.resolve('docs/research');
const CUST = devCustomer();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
try {
  await page.goto(`${STORE}/`, { waitUntil: 'domcontentloaded' });
  const loginBtn = page
    .locator('header')
    .getByRole('button', { name: /^login$/i })
    .first();
  await loginBtn.waitFor({ state: 'visible', timeout: 60000 });
  await loginBtn.click();
  const email = page.locator('input[name="email"]');
  await email.waitFor({ state: 'visible', timeout: 20000 });
  await email.fill(CUST.email);
  await page.fill('input[name="password"]', CUST.password);
  await page.press('input[name="password"]', 'Enter');
  await email.waitFor({ state: 'detached', timeout: 15000 });

  await page.goto(`${STORE}/transactions`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.screenshot({
    path: path.join(OUT, 'tgpay-statement.png'),
    fullPage: true,
  });
  const rows = await page.locator('tbody tr').allInnerTexts();
  console.log(
    'rows:',
    rows
      .slice(0, 5)
      .map((r) => r.replace(/\s+/g, ' '))
      .join('\n      '),
  );

  await page.goto(`${STORE}/wallet`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.screenshot({
    path: path.join(OUT, 'tgpay-wallet.png'),
    fullPage: true,
  });
} finally {
  await browser.close();
}
