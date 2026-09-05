// End-to-end sandbox deposit through TGPay's hosted checkout.
//
// Logs the dev customer in on the prod storefront (:4000 by default), opens
// the top-up sheet from the header, pays RM <AMOUNT> by online banking, follows
// the redirect to TGPay's hosted checkout, screenshots every hop into
// docs/research/tgpay-*.png, and — if the sandbox simulator exposes an obvious
// "pay"/"approve" control — clicks it and waits to land back on our
// redirectUrl. Prints the merchant reference so the row can be checked in the
// DB afterwards.
//
//   node scripts/qa-tgpay-deposit.mjs            # RM 50, OB
//   AMOUNT=100 METHOD=BQR node scripts/qa-tgpay-deposit.mjs
//
// Credentials come from env only (CUST_EMAIL / CUST_PW), the same way
// login-stack.mjs reads them; launch-stack.ps1 injects scripts/.dev-logins.

import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { safeBase } from './lib/dev-logins.mjs';

const STORE = safeBase(process.env.STORE_BASE, 'http://127.0.0.1:4000');
const AMOUNT = Number(process.env.AMOUNT ?? 50);
const METHOD = process.env.METHOD ?? 'OB';
const CUST = {
  email: process.env.CUST_EMAIL ?? 'test@polycards.app',
  password: process.env.CUST_PW ?? '',
};
const OUT = path.resolve('docs/research');
fs.mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const shot = (page, name) =>
  page.screenshot({
    path: path.join(OUT, `tgpay-${name}.png`),
    fullPage: true,
  });

// Read .dev-logins if the env is empty, so the script also works standalone.
if (!CUST.password) {
  try {
    const raw = fs.readFileSync(path.resolve('scripts/.dev-logins'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (!m) continue;
      if (m[1] === 'CUST_PW' && m[2]) CUST.password = m[2];
      if (m[1] === 'CUST_EMAIL' && m[2]) CUST.email = m[2];
    }
  } catch {
    /* no file — env only */
  }
}
if (!CUST.password) {
  console.error(
    'CUST_PW not set (env or scripts/.dev-logins) — cannot log in.',
  );
  process.exit(2);
}

const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const context = await browser.newContext({
  viewport: { width: 430, height: 932 },
});
const page = await context.newPage();

// The backend call the sheet makes; we want its JSON for the reference + URL.
let depositResponse = null;
page.on('response', async (res) => {
  if (
    res.url().endsWith('/store/credits/deposit') &&
    res.request().method() === 'POST'
  ) {
    try {
      depositResponse = { status: res.status(), body: await res.json() };
    } catch {
      depositResponse = { status: res.status(), body: null };
    }
  }
});

try {
  // 1) Login (same flow as login-stack.mjs).
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
  log('logged in as', CUST.email);

  // 2) Open the top-up sheet from the header and fill it.
  await page.goto(`${STORE}/me`, { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('button', { name: /top up/i })
    .first()
    .click();
  const dialog = page.getByRole('dialog', { name: /top up credits/i });
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  const amountInput = dialog.getByLabel(/top-up amount in rm/i);
  await amountInput.fill(String(AMOUNT));
  const method = dialog.locator(
    `input[name="deposit-method"][value="${METHOD}"]`,
  );
  if (await method.count()) await method.check({ force: true });
  await shot(page, '1-sheet');

  // 3) Pay — the sheet POSTs /store/credits/deposit then leaves for the gateway.
  const payBtn = dialog.getByRole('button', { name: /^pay rm/i });
  await payBtn.waitFor({ state: 'visible', timeout: 10000 });
  await Promise.all([
    page
      .waitForURL((u) => !u.toString().startsWith(STORE), { timeout: 60000 })
      .catch(() => {}),
    payBtn.click(),
  ]);
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(2500);
  log('deposit response:', JSON.stringify(depositResponse));
  log('landed on:', page.url());
  await shot(page, '2-checkout');

  const ref = depositResponse?.body?.merchantTransactionId ?? '(none)';
  const txn = depositResponse?.body?.transactionId ?? '(none)';
  log(`merchantRefNum=${ref} gatewayOrder=${txn}`);

  // 4) Best-effort: drive the sandbox simulator if it shows an obvious control.
  if (!page.url().startsWith(STORE)) {
    const candidates = [
      /approve/i,
      /^pay$/i,
      /pay now/i,
      /confirm/i,
      /success/i,
      /proceed/i,
      /continue/i,
    ];
    for (let hop = 0; hop < 4; hop++) {
      let clicked = false;
      for (const re of candidates) {
        const btn = page.getByRole('button', { name: re }).first();
        if ((await btn.count()) && (await btn.isVisible().catch(() => false))) {
          log(
            `hop ${hop}: clicking "${await btn.innerText()}" on ${page.url()}`,
          );
          await btn.click().catch(() => {});
          clicked = true;
          break;
        }
        const link = page.getByRole('link', { name: re }).first();
        if (
          (await link.count()) &&
          (await link.isVisible().catch(() => false))
        ) {
          log(
            `hop ${hop}: following "${await link.innerText()}" on ${page.url()}`,
          );
          await link.click().catch(() => {});
          clicked = true;
          break;
        }
      }
      await page.waitForTimeout(3000);
      await shot(page, `3-hop${hop}`);
      if (page.url().startsWith(STORE)) {
        log('back on storefront:', page.url());
        break;
      }
      if (!clicked) {
        log(
          'no obvious control on',
          page.url(),
          '— stopping here; inspect the screenshot',
        );
        break;
      }
    }
  }

  await shot(page, '4-final');
  console.log(`\nRESULT ref=${ref} order=${txn} final=${page.url()}`);
} catch (e) {
  await shot(page, 'error').catch(() => {});
  console.error('FAILED:', e);
  process.exitCode = 1;
} finally {
  await browser.close();
}
