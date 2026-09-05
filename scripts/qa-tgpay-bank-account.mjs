// Saved-bank-account smoke (plan 130 §bank preservation): log the dev
// customer in, save the TGPay sandbox dummy bank on /bank, then print what the
// backend stored (canonical bank id) and how /bank-withdrawal lists it.
//
//   node scripts/qa-tgpay-bank-account.mjs        # STORE_BASE defaults to :4000

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

  await page.goto(`${STORE}/bank`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /add bank account/i }).click();
  const bank = page.getByLabel('Bank');
  await bank.waitFor({ state: 'visible', timeout: 20000 });
  const options = await bank.locator('option').allTextContents();
  console.log(
    'picker options:',
    options.slice(0, 6).join(' | '),
    '…',
    options.length,
    'total',
  );
  await bank.selectOption({ label: 'Dummy Bank Verified (sandbox)' });
  await page.getByLabel('Account number').fill('543478924652');
  await page.getByLabel('Account holder name').fill('Michael Yap');
  await page.getByRole('button', { name: /save account/i }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({
    path: path.join(OUT, 'tgpay-bank-saved.png'),
    fullPage: true,
  });

  await page.goto(`${STORE}/bank-withdrawal`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(2500);
  const choices = await page.locator('select option').allTextContents();
  console.log('withdraw picker:', choices.map((c) => c.trim()).join(' | '));
  await page.screenshot({
    path: path.join(OUT, 'tgpay-withdraw-form.png'),
    fullPage: true,
  });
} finally {
  await browser.close();
}
