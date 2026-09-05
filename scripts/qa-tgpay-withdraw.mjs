// Customer withdrawal smoke (plan 130): log the dev customer in on the prod
// storefront, request RM <AMOUNT> to the first usable saved account on
// /bank-withdrawal, screenshot, and print the resulting message. Pair with
// the DB/callback checks afterwards.
//
//   AMOUNT=50 node scripts/qa-tgpay-withdraw.mjs

import { chromium } from '@playwright/test';
import path from 'node:path';
import { devCustomer, safeBase } from './lib/dev-logins.mjs';

const STORE = safeBase(process.env.STORE_BASE, 'http://127.0.0.1:4000');
const AMOUNT = process.env.AMOUNT ?? '50';
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

  await page.goto(`${STORE}/bank-withdrawal`, {
    waitUntil: 'domcontentloaded',
  });
  const account = page.getByLabel('Saved bank account');
  await account.waitFor({ state: 'visible', timeout: 20000 });
  const usable = await account
    .locator('option:not([disabled])')
    .first()
    .getAttribute('value');
  if (!usable) throw new Error('no usable saved account');
  await account.selectOption(usable);
  await page.getByLabel('Withdrawal amount in RM').fill(AMOUNT);
  await page.screenshot({
    path: path.join(OUT, 'tgpay-withdraw-1-form.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: /withdraw|request/i })
    .last()
    .click();
  await page.waitForTimeout(6000);
  await page.screenshot({
    path: path.join(OUT, 'tgpay-withdraw-2-result.png'),
    fullPage: true,
  });
  const text = await page
    .locator('main')
    .innerText()
    .catch(() => page.locator('body').innerText());
  console.log(text.replace(/\s+/g, ' ').slice(0, 600));
} finally {
  await browser.close();
}
