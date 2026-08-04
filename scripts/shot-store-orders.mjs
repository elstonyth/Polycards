// scripts/shot-store-orders.mjs — capture the customer /orders page for the
// review artifact, so the delivery cancel-window change is visible on both
// sides of its new boundary.
//
// Run from the repo ROOT against the PROD build (:4000 — login is unreliable on
// `next dev`, see the launching-pokenic-stack skill):
//   pwsh scripts/launch-stack.ps1 -Verify
//   SHOT_NAME=orders-processed node scripts/shot-store-orders.mjs
//
// Password comes from env ONLY (the launch script injects it from the
// gitignored scripts/.dev-logins).
// Env: STORE_BASE, CUST_EMAIL, CUST_PW, SHOT_NAME
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

// 127.0.0.1, not localhost: the storefront sends an HSTS header, which makes
// Chrome force-upgrade http://localhost to https and land on an error page.
const STORE = process.env.STORE_BASE ?? 'http://127.0.0.1:4000';
const CUST = {
  email: process.env.CUST_EMAIL ?? 'test@polycards.app',
  password: process.env.CUST_PW ?? '',
};
const NAME = process.env.SHOT_NAME ?? 'orders';
const OUT = 'docs/research/shots';
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Retry the WHOLE flow (same reason as login-stack.mjs): the auth modal is
// opened from the header, and a bare fill before it mounts throws uncaught.
async function customerLogin(page) {
  for (let i = 0; i < 4; i++) {
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
      // Logged in when the modal unmounts — the header button is not a reliable
      // signal (it never reliably detaches).
      await email.waitFor({ state: 'detached', timeout: 20000 });
      return true;
    } catch (e) {
      log(
        `login attempt ${i + 1} failed (${String(e.message).split('\n')[0]}), retrying…`,
      );
      await page.waitForTimeout(3000);
    }
  }
  return false;
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 1400, height: 1000 },
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();

if (!CUST.password) {
  log('CUST_PW not set — cannot log in');
  process.exit(1);
}
if (!(await customerLogin(page))) {
  log('customer login FAILED');
  process.exit(1);
}
log('logged in as', CUST.email);

await page.goto(`${STORE}/orders`, { waitUntil: 'networkidle' });
// The cookie banner is fixed to the bottom of every page and would sit in the
// frame of a shot that is about a table.
const reject = page.getByRole('button', { name: /^reject$/i }).first();
if (await reject.count()) {
  await reject.click().catch(() => {});
}
await page.waitForTimeout(2000);

// Clip from the page heading through the last order row: the rest is empty
// background, and a screenshot that is 70% background reads as a mistake.
const heading = page.getByRole('heading', { name: 'Orders' }).first();
const top = await heading.boundingBox();
const rows = page.locator('table, [role="table"]').first();
const table = (await rows.count()) ? await rows.boundingBox() : null;
const bottom = table ? table.y + table.height : top.y + 420;
const file = `${OUT}/${NAME}.png`;
await page.screenshot({
  path: file,
  clip: {
    x: Math.max(top.x - 40, 0),
    y: Math.max(top.y - 40, 0),
    width: Math.min(1400 - Math.max(top.x - 40, 0), 1320),
    height: bottom - top.y + 90,
  },
});
log('shot', file);

await browser.close();
