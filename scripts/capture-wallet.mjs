// Screenshot the redesigned /wallet page as a logged-in customer, desktop + mobile.
// Login flow copied from scripts/login-stack.mjs (header modal, no /login route).
// Run from repo ROOT so @playwright/test resolves. Env: STORE_BASE, CUST_EMAIL, CUST_PW
import { chromium } from '@playwright/test';

const STORE = process.env.STORE_BASE ?? 'http://127.0.0.1:4000';
// NOTE: the customer account kept its pre-rebrand pokenic.app email — login-stack.mjs's
// polycards.app default is wrong and silently fails every attempt.
const EMAIL = process.env.CUST_EMAIL ?? 'test@pokenic.app';
const PW = process.env.CUST_PW ?? '';
const OUT = 'docs/research';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function login(page) {
  for (let i = 0; i < 4; i++) {
    try {
      await page.goto(`${STORE}/`, { waitUntil: 'domcontentloaded' });
      const btn = page
        .locator('header')
        .getByRole('button', { name: /^login$/i })
        .first();
      await btn.waitFor({ state: 'visible', timeout: 60000 });
      await btn.click();
      const email = page.locator('input[name="email"]');
      await email.waitFor({ state: 'visible', timeout: 20000 });
      await email.fill(EMAIL);
      await page.fill('input[name="password"]', PW);
      await page.press('input[name="password"]', 'Enter');
      await email.waitFor({ state: 'detached', timeout: 15000 });
      return true;
    } catch (e) {
      log(`login attempt ${i + 1} failed: ${String(e.message).split('\n')[0]}`);
      await page.waitForTimeout(3000);
    }
  }
  return false;
}

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 1400 },
});
const page = await ctx.newPage();

if (!PW) {
  console.error('CUST_PW not set');
  process.exit(1);
}
const ok = await login(page);
log(`login=${ok}`);
if (!ok) {
  await browser.close();
  process.exit(1);
}

await page.goto(`${STORE}/wallet`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/wallet-desktop.png`, fullPage: true });
log('desktop shot done');

// Dump the gate numbers so the screenshot can be sanity-checked against the ledger.
const text = await page
  .locator('main')
  .innerText()
  .catch(() => '');
log('--- page text ---\n' + text.slice(0, 1200));

await page.setViewportSize({ width: 390, height: 900 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${OUT}/wallet-mobile.png`, fullPage: true });
log('mobile shot done');

await browser.close();
