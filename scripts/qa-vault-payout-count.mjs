// qa-vault-payout-count.mjs — proves the vault action bar's "Sell for" figure
// stays in sync with the selection. The bug this guards: rendering a hard 0
// while nothing is selected desynced useCountedValue, so a reselect mid-count
// jumped the display to a hidden intermediate.
// Usage: node scripts/qa-vault-payout-count.mjs [baseUrl]
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4000';

const CREDS_FILE = path.join(process.cwd(), 'scripts/.dev-logins');
const creds = existsSync(CREDS_FILE)
  ? Object.fromEntries(
      readFileSync(CREDS_FILE, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim() && !l.trim().startsWith('#'))
        .map((l) => {
          const i = l.indexOf('=');
          if (i <= 0)
            throw new Error(`Malformed line in scripts/.dev-logins: ${l}`);
          return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    )
  : {};
const EMAIL = creds.CUST_EMAIL ?? process.env.PW_EMAIL;
const PASSWORD = creds.CUST_PW ?? process.env.PW_PASSWORD;
if (!EMAIL || !PASSWORD) throw new Error('No customer credentials.');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });

await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
await page
  .getByRole('button', { name: 'Accept' })
  .click({ timeout: 5000 })
  .catch(() => {});
const loginBtn = page
  .locator('header')
  .getByRole('button', { name: /^login$/i })
  .first();
await loginBtn.waitFor({ state: 'visible', timeout: 45000 });
await loginBtn.click();
const email = page.locator('input[name="email"]');
await email.waitFor({ state: 'visible', timeout: 20000 });
await email.fill(EMAIL);
await page.fill('input[name="password"]', PASSWORD);
await page.press('input[name="password"]', 'Enter');
await email.waitFor({ state: 'detached', timeout: 20000 }).catch(() => {
  throw new Error('login did not complete — the auth modal never closed');
});

await page.goto(BASE + '/vault', {
  waitUntil: 'domcontentloaded',
  timeout: 30000,
});
const payout = page.getByText(/^Sell for RM/);
await payout.waitFor({ state: 'visible', timeout: 20000 });

const read = () => payout.innerText();
const rm = async () => Number((await read()).replace(/[^0-9.]/g, ''));
/** The counted figure settles within ~650ms; poll a little past that. */
const settled = async () => {
  await page.waitForTimeout(1100);
  return rm();
};

// Two traps in one locator: the tile's aria-label flips between "Select X" and
// "Deselect X" (so a "Select "-prefixed locator silently re-targets a DIFFERENT
// tile once one is selected), and the vault holds duplicate card names (three
// PW Gengars), so a name-based locator hits the same tile twice. Match both
// states and index positionally — grid order is stable across selection.
const tiles = page.locator(
  'button[aria-label^="Select "], button[aria-label^="Deselect "]',
);
if ((await tiles.count()) < 2)
  throw new Error(`vault has ${await tiles.count()} selectable tiles`);
const toggle = (i) => tiles.nth(i);
const [cardA, cardB] = [0, 1];

const results = {};
results.idle = await settled();

await toggle(cardA).click();
results.oneSelected = await settled();

await toggle(cardB).click();
results.twoSelected = await settled();

// Deselect everything: the figure must come back to 0, not strand on an
// intermediate from the interrupted count.
await toggle(cardA).click();
await toggle(cardB).click();
results.deselected = await settled();

// Reselect immediately after a deselect (mid-count) — the settled value must
// equal the single-card payout, not some blend with the previous total.
await toggle(cardA).click();
await page.waitForTimeout(120);
await toggle(cardA).click();
await toggle(cardA).click();
results.reselectedMidCount = await settled();

console.log(JSON.stringify(results, null, 2));
await browser.close();

const fail = (m) => {
  throw new Error(`FAIL: ${m}`);
};
if (results.idle !== 0) fail(`idle payout is ${results.idle}, expected 0`);
if (!(results.oneSelected > 0)) fail('selecting a card did not raise payout');
if (!(results.twoSelected > results.oneSelected))
  fail('second card did not raise payout');
if (results.deselected !== 0)
  fail(`deselect-all stranded payout at ${results.deselected}, expected 0`);
if (results.reselectedMidCount !== results.oneSelected)
  fail(
    `mid-count reselect settled at ${results.reselectedMidCount}, expected ` +
      `${results.oneSelected} (a hidden intermediate leaked in)`,
  );
console.log('PASS: payout figure tracks the selection, settles exactly.');
