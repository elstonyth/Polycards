// QA the Task A1 top-up flow on the PROD build (:4000): login → /vault →
// Add credits → balance stat updates in place → demo decline (.13) shows the
// friendly error. Headless; screenshots to docs/research/.
// Run: node scripts/qa-topup.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:4000';
const EMAIL = 'stocktest-1@pokenic.local';
const PASSWORD = 'stocktest2026!';
const TOPUP = 7.77; // odd amount so the balance delta is unambiguous
const DECLINE = 5.13; // the demo gateway's always-decline pattern

const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};
const ok = (m) => console.log(`✓ ${m}`);

const browser = await chromium.launch({ headless: true });
const page = await (
  await browser.newContext({ viewport: { width: 1440, height: 900 } })
).newPage();

const balanceStat = async () => {
  const card = page
    .locator('div', { hasText: /^Credit balance/ })
    .locator('p.font-heading')
    .first();
  const text = await card.textContent();
  const n = Number(text.replace(/[$,]/g, ''));
  if (!Number.isFinite(n)) throw new Error(`unparsable balance stat: ${text}`);
  return n;
};

try {
  await page.goto(`${BASE}/claw`, { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('button', { name: /^login$/i })
    .first()
    .click();
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.press('input[name="password"]', 'Enter');
  await page.waitForTimeout(2500); // let the auth cookie land

  await page.goto(`${BASE}/vault`, { waitUntil: 'domcontentloaded' });
  await page.getByText(/^Credit balance/i).waitFor({ timeout: 20000 });
  const before = await balanceStat();
  ok(`logged in; balance before: $${before.toFixed(2)}`);

  // Top-up: open the panel, enter the custom amount, submit.
  await page.getByRole('button', { name: /add credits/i }).click();
  await page.getByLabel('Top-up amount in USD').fill(String(TOPUP));
  await page.screenshot({ path: 'docs/research/qa-topup-panel.png' });
  await page.getByRole('button', { name: /^Add \$7\.77$/ }).click();
  await page.getByText(/added to your balance/i).waitFor({ timeout: 15000 });
  const after = await balanceStat();
  const delta = Math.round((after - before) * 100) / 100;
  if (delta === TOPUP)
    ok(`top-up credited: balance $${after.toFixed(2)} (+$${TOPUP})`);
  else fail(`balance delta ${delta}, expected ${TOPUP}`);

  // Decline path: .13 must error and leave the balance untouched.
  await page.getByLabel('Top-up amount in USD').fill(String(DECLINE));
  await page.getByRole('button', { name: /^Add \$5\.13$/ }).click();
  await page.getByText(/declined/i).waitFor({ timeout: 15000 });
  const afterDecline = await balanceStat();
  if (afterDecline === after)
    ok('decline path: error shown, balance unchanged');
  else fail(`balance moved on decline: $${after} → $${afterDecline}`);

  await page.screenshot({ path: 'docs/research/qa-topup-decline.png' });
} catch (err) {
  fail(err.message);
  await page.screenshot({ path: 'docs/research/qa-topup-error.png' });
} finally {
  await browser.close();
}
