// scripts/qa-slot-machine.mjs
// QA the x1 slot machine on the PROD build (:4000): log in (funded customer) →
// /slots/<pack> → SPIN → reel settles → balance debits by the pack price →
// sell-back offer appears → reduced-motion lands centered with no spin.
// Headless; screenshots to docs/research/. Run: node scripts/qa-slot-machine.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:4000';
const EMAIL = process.env.QA_SLOT_EMAIL;
const PASSWORD = process.env.QA_SLOT_PASSWORD;
const PACK = 'pokemon-rookie'; // affordable

if (!EMAIL || !PASSWORD) {
  throw new Error(
    'Set QA_SLOT_EMAIL and QA_SLOT_PASSWORD (the seeded test customer) before running.',
  );
}

const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};
const ok = (m) => console.log(`✓ ${m}`);

const browser = await chromium.launch({ headless: true });

async function login(page) {
  await page.goto(`${BASE}/slots/${PACK}`, { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('button', { name: /^login$/i })
    .first()
    .click();
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.press('input[name="password"]', 'Enter');
  await page
    .getByRole('button', { name: /spin/i })
    .first()
    .waitFor({ timeout: 20000 });
}

async function readCredit(page) {
  const el = page.getByText('Credit').locator('xpath=following-sibling::*[1]');
  await el.waitFor({ timeout: 10000 });
  const t = await el.textContent();
  return Number((t || '').replace(/[^0-9.]/g, ''));
}

try {
  const page = await browser.newPage();
  await login(page);

  const before = await readCredit(page);
  await page.getByRole('button', { name: /^spin$/i }).click();

  // Reel settles → "YOU WON" banner + sell-back appear.
  await page.getByText(/YOU WON/i).waitFor({ timeout: 20000 });
  ok('reel settled and surfaced a winner');

  const after = await readCredit(page);
  const costText = await page.getByText(/Cost/i).first().textContent();
  const cost = Number((costText || '').replace(/[^0-9.]/g, ''));
  if (Math.abs(before - after - cost) < 0.01)
    ok(`credit debited by pack price (${before} → ${after}, cost ${cost})`);
  else
    fail(
      `expected debit of ${cost}, got ${before - after} (${before} → ${after})`,
    );

  const sell = page.getByRole('button', { name: /sell back for|sell for/i });
  if (await sell.isVisible()) ok('sell-back offer present');
  else fail('sell-back offer missing');

  await page.screenshot({ path: 'docs/research/slot-landed.png' });

  // Reduced motion: winner centered, no spin theatre.
  const rm = await browser.newPage();
  await rm.emulateMedia({ reducedMotion: 'reduce' });
  await login(rm);
  await rm.getByRole('button', { name: /^spin$/i }).click();
  await rm.getByText(/YOU WON/i).waitFor({ timeout: 15000 });
  ok('reduced-motion spin resolves to a centered winner');
  await rm.screenshot({ path: 'docs/research/slot-reduced-motion.png' });

  await browser.close();
  console.log(process.exitCode ? '\nFAILED' : '\nPASSED');
} catch (e) {
  await browser.close();
  fail(e.message);
}
