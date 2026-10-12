#!/usr/bin/env node
// UI pass for the A3Pay (SGD) rail on the LOCAL stack: admin sets the markup
// on the Settlement page, then a customer tops up in S$ through the sheet,
// pays on the mock cashier, and sees the RM credit; then the withdraw form
// shows what a Singapore bank receives. Screenshots -> docs/research/a3pay-*.png
//
// Prereqs: same as scripts/a3pay-e2e.mjs, plus the standalone storefront on
// :4000 (npm run build && pwsh scripts/serve-standalone.ps1 -Port 4000) and
// the admin on :7000. Logins from gitignored scripts/.dev-logins.
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';

const STORE = 'http://127.0.0.1:4000';
const ADMIN = 'http://localhost:7000/dashboard';

const MOCK = 'http://127.0.0.1:4455';
const OUT = new URL('../docs/research/', import.meta.url).pathname.replace(
  /^\/(\w:)/,
  '$1',
);

const logins = Object.fromEntries(
  readFileSync(new URL('./.dev-logins', import.meta.url), 'utf8')
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
const shot = (page, name) =>
  page.screenshot({ path: `${OUT}a3pay-${name}.png`, fullPage: false });

const browser = await chromium.launch();

// ---------------------------------------------------------------- admin
{
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await ctx.newPage();
  await page.goto(`${ADMIN}/login`);
  await page.fill(
    'input[name="email"]',
    logins.ADMIN_EMAIL || 'admin@pokenic.app',
  );
  await page.fill('input[name="password"]', logins.ADMIN_PW);
  await page.keyboard.press('Enter');
  await page.waitForURL((u) => !u.pathname.includes('login'), {
    timeout: 30000,
  });
  await page.goto(`${ADMIN}/settlement`);
  const card = page.getByTestId('sgd-fx-card');
  await card.waitFor({ timeout: 30000 });
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await card.screenshot({ path: `${OUT}a3pay-admin-card-before.png` });

  // Back to the live feed rate, markup 0.05 RM per S$1.
  const override = card.locator('#sgd-override');
  if ((await override.getAttribute('data-state')) === 'checked')
    await override.click();
  await card.locator('#sgd-markup').fill('0.05');
  await card.locator('#sgd-reason').fill('UI QA: feed rate, 0.05 markup');
  const preview = await card.getByTestId('sgd-fx-preview').innerText();
  check(
    'admin preview shows customer rates live',
    /S\$100 top-up → RM \d+\.\d\d credit/.test(preview),
    preview,
  );
  await card.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Save' }).last().click(); // confirm prompt
  await page.waitForTimeout(1500);
  await card.screenshot({ path: `${OUT}a3pay-admin-card-after.png` });
  const fxState = await page.evaluate(async () =>
    (
      await fetch('http://localhost:9000/admin/payments/fx', {
        credentials: 'include',
      })
    ).json(),
  );
  check(
    'admin save applied: feed rate, markup 0.05',
    fxState.markup === 0.05 &&
      fxState.manual_override === false &&
      fxState.quote?.source === 'feed',
    JSON.stringify(fxState.quote),
  );
  await ctx.close();
}

// ---------------------------------------------------------------- storefront
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
// The mock's cashier lives on a fake https host — answer it here so the
// browser can "arrive" there; paying is driven on the mock directly.
await page.route('https://cashier.a3pay.mock/**', (route) =>
  route.fulfill({
    contentType: 'text/html',
    body: '<h1>A3Pay cashier (mock)</h1>',
  }),
);

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

// Before the top-up: a deposit re-locks the balance behind playthrough.
// Withdraw form: pick the Singapore account, see what DBS receives.
await page.goto(`${STORE}/bank-withdrawal`);
const select = page.getByLabel('Saved bank account');
await select.waitFor({ timeout: 20000 });
const dbs = await select
  .locator('option', { hasText: 'DBS Bank' })
  .first()
  .getAttribute('value');
await select.selectOption(dbs);
await page.getByLabel('Withdrawal amount in RM').fill('100');
const est = page.getByTestId('withdraw-sgd-estimate');
await est.waitFor({ timeout: 5000 });
check(
  'withdraw form shows the S$ a Singapore bank receives',
  /S\$\d+\.\d\d/.test(await est.innerText()),
  (await est.innerText()).replace(/\s+/g, ' '),
);
check(
  'withdraw button names both amounts',
  await page
    .getByRole('button', { name: /Withdraw RM 100\.00 → S\$/ })
    .isVisible(),
);
await est.scrollIntoViewIfNeeded();
await shot(page, 'withdraw-sgd');

await page.goto(`${STORE}/me`);
await page
  .getByRole('button', { name: /top up/i })
  .first()
  .click();
const sheet = page.getByRole('dialog', { name: 'Top up credits' });
await sheet.waitFor();
await page.waitForTimeout(1200);
check(
  'top-up sheet offers "Pay in S$"',
  await sheet.getByText('Pay in S$').isVisible(),
);
await shot(page, 'topup-rm');

await sheet.getByText('Pay in S$').click();
await sheet.getByRole('button', { name: 'S$100' }).click();
await page.waitForTimeout(300);
const credit = await sheet.getByTestId('topup-credit').innerText();
const rateLine = await sheet.getByText(/^S\$1 = RM/).innerText();
const rate = Number(rateLine.match(/RM ([\d.]+)/)[1]);
const expected = Math.floor(10000 * rate + 1e-6) / 100;
check(
  'S$100 shows the quoted RM credit',
  credit.includes(expected.toFixed(2)),
  `${credit} at ${rateLine}`,
);
check(
  'Pay button disabled until the account name is entered',
  await sheet
    .getByRole('button', { name: 'Enter the account name' })
    .isDisabled(),
);
await sheet.getByPlaceholder('As it appears at your bank').fill('TAN AH KOW');
await shot(page, 'topup-sgd');

const balBefore = await page.evaluate(async () =>
  document
    .querySelector('header button[aria-label^="Balance"]')
    ?.getAttribute('aria-label'),
);
await sheet.getByRole('button', { name: /Pay S\$100\.00/ }).click();
await page.waitForURL(/cashier\.a3pay\.mock\/cashier\/(D\d+)/, {
  timeout: 20000,
});
const orderId = page.url().match(/cashier\/(D\d+)/)[1];
check('customer is sent to the A3Pay cashier', Boolean(orderId), page.url());
// The customer pays on the cashier: the mock settles and sends the signed callback.
await fetch(`${MOCK}/cashier/${orderId}/pay`, { redirect: 'manual' });
await page.goto(`${STORE}/me`);
await page.waitForTimeout(2500);
const balAfter = await page.evaluate(() =>
  document
    .querySelector('header button[aria-label^="Balance"]')
    ?.getAttribute('aria-label'),
);
const num = (s) => Number(String(s).replace(/[^\d.]/g, ''));
check(
  'balance rises by the quoted RM credit',
  Math.round((num(balAfter) - num(balBefore)) * 100) ===
    Math.round(expected * 100),
  `${balBefore} -> ${balAfter}`,
);
await shot(page, 'me-after-sgd-topup');

await browser.close();
console.log(failures ? `${failures} FAILED` : 'all UI checks passed');
process.exit(failures ? 1 : 0);
