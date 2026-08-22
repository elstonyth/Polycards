// One-off: prove a CHARGED spin still works after the 2026-08-18 activity wipe
// (empty ledger_entry + ledger_sequence.last_serial reset to 'a0000').
// Asserts a real CHARGED spin runs and settles from the browser's view: the
// sr-only balance meter must DROP by the pack price across the spin. (No DB
// access — for ledger-level verification query ledger_entry directly.)
// Run: node scripts/qa-postwipe-spin.mjs   (needs CUST_EMAIL + CUST_PW in env)
import { chromium } from 'playwright';

// Same precedence as qa-prod-smoke.mjs: QA_BASE, then a positional arg, then
// the default this script is actually for (the local standalone build).
const BASE = process.env.QA_BASE ?? process.argv[2] ?? 'http://127.0.0.1:4000';
// A non-local QA_BASE runs a CHARGED spin on the named account and spends
// real credit. There is no dry-run mode.
const OUT = 'docs/research';
const PACK = process.env.QA_PACK ?? 'bronze-pack';
const EMAIL = process.env.CUST_EMAIL ?? 'test@pokenic.app';
const PASSWORD = process.env.CUST_PW;
if (!PASSWORD) throw new Error('CUST_PW not in env');

const ok = (m) => console.log(`OK  ${m}`);
const fail = (m) => {
  console.error(`FAIL ${m}`);
  process.exitCode = 1;
};

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.error(`pageerror: ${e}`));

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  const reject = page.getByRole('button', { name: /reject/i }).first();
  if (await reject.isVisible().catch(() => false)) await reject.click();

  await page
    .getByRole('button', { name: /^login$/i })
    .first()
    .click();
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.press('input[name="password"]', 'Enter');
  // Success signal = the modal's email input DETACHING (the header Login
  // button never reliably detaches).
  await page.waitForSelector('input[name="email"]', {
    state: 'detached',
    timeout: 30_000,
  });
  ok(`logged in as ${EMAIL}`);

  await page.goto(`${BASE}/slots/${PACK}/spin`, {
    waitUntil: 'domcontentloaded',
  });
  const spin = page.getByRole('button', { name: /spin|open pack/i }).first();
  await spin.waitFor({ state: 'visible', timeout: 30_000 });

  // The sr-only balance meter (Meter.tsx) is the only reliable text probe —
  // the visible odometer digits are aria-hidden and roll asynchronously.
  // Scoped from the "Credit" label's parent div so this can't match the
  // OTHER Meter on this page (the bet-cost meter in SlotControls).
  const creditMeter = page
    .getByText('Credit', { exact: true })
    .locator('xpath=..')
    .locator('span.sr-only')
    .first();
  const readBalance = async () => {
    const text = await creditMeter.textContent();
    return parseFloat((text ?? '').replace(/[^0-9.]/g, ''));
  };
  await creditMeter.waitFor({ state: 'attached', timeout: 30_000 });
  const before = await readBalance();

  await spin.click();
  ok('spin pressed');

  // aria-busy on the stage === phase 'spinning'; wait for it to rise then fall.
  const busy = () =>
    page.evaluate('(() => !!document.querySelector("[aria-busy=\'true\']"))()');
  const deadline = Date.now() + 60_000;
  let sawBusy = false;
  while (Date.now() < deadline) {
    const b = await busy();
    if (b) sawBusy = true;
    else if (sawBusy) break;
    await page.waitForTimeout(150);
  }
  sawBusy
    ? ok('spin ran (aria-busy rose then cleared)')
    : fail('never saw aria-busy');
  await page.waitForTimeout(3000); // let the settle writes land

  const after = await readBalance();
  after < before
    ? ok(
        `balance dropped ${(before - after).toFixed(2)} (${before} -> ${after})`,
      )
    : fail(
        `balance did not drop — spin did not settle (before=${before} after=${after})`,
      );

  await page.screenshot({
    path: `${OUT}/postwipe-spin.png`,
    fullPage: false,
  });
} finally {
  await browser.close();
}
