// QA the Task A2 charge loop on the PROD build (:4000): top up → pack detail
// shows price + balance → open debits exactly the price → vault sell-back
// refills — plus the insufficient-credit error path on a fresh customer.
// Headless; screenshots to docs/research/. Run: node scripts/qa-pack-open-charge.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:4000';
const BACKEND = 'http://localhost:9000';
const PK =
  'pk_a23d4482ee6673a760097f3d013aab59679ceaebab54f987638cbeeb0132863c';
const EMAIL = 'stocktest-1@pokenic.local';
const PASSWORD = 'stocktest2026!';
const PACK = 'pokemon-rookie'; // $25 — affordable inside the $100 top-up
const TOPUP = 100;

const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};
const ok = (m) => console.log(`✓ ${m}`);

const browser = await chromium.launch({ headless: true });

async function login(page, email, password) {
  await page.goto(`${BASE}/claw/${PACK}`, { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('button', { name: /^login$/i })
    .first()
    .click();
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await page.press('input[name="password"]', 'Enter');
  await page
    .getByRole('button', { name: /open pack/i })
    .waitFor({ timeout: 20000 });
}

// The CTA footer line: "Each open costs $X in site credits — your balance: $Y"
async function readPriceAndBalance(page) {
  const line = page.getByText(/Each open costs \$/);
  await line.waitFor({ timeout: 15000 });
  const text = await line.textContent();
  const m = text.match(
    /costs \$([\d,.]+) in site credits — your balance:\s*\$([\d,.]+)/,
  );
  if (!m) throw new Error(`unparsable price/balance line: ${text}`);
  return {
    price: Number(m[1].replace(/,/g, '')),
    balance: Number(m[2].replace(/,/g, '')),
  };
}

async function playRevealAndKeep(page) {
  await page.waitForTimeout(2600); // cylinder shuffle settles
  await page.mouse.click(720, 420); // pack → slab
  await page.waitForTimeout(1000);
  await page.mouse.click(720, 420); // slab → metadata → card
  const keep = page.getByRole('button', { name: /keep in vault/i });
  await keep.waitFor({ timeout: 25000 });
  await keep.click();
  await page.waitForTimeout(800);
}

try {
  // ── Flow A: funded loop on the stocktest customer ────────────────────────
  const page = await (
    await browser.newContext({ viewport: { width: 1440, height: 860 } })
  ).newPage();

  await login(page, EMAIL, PASSWORD);
  ok('logged in (stocktest)');

  // Top up via the A1 panel so the open below is definitely funded.
  await page.goto(`${BASE}/vault`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /add credits/i }).click();
  await page.getByLabel('Top-up amount in USD').fill(String(TOPUP));
  await page.getByRole('button', { name: /^Add \$100\.00$/ }).click();
  await page.getByText(/added to your balance/i).waitFor({ timeout: 15000 });
  ok(`topped up $${TOPUP}`);

  // Pack detail shows price + live balance.
  await page.goto(`${BASE}/claw/${PACK}`, { waitUntil: 'domcontentloaded' });
  const before = await readPriceAndBalance(page);
  ok(`pack detail: price $${before.price}, balance $${before.balance}`);
  await page.screenshot({ path: 'docs/research/qa-a2-detail.png' });

  // Open → reveal → keep. The footer balance must drop by exactly the price.
  await page.getByRole('button', { name: /open pack/i }).click();
  await playRevealAndKeep(page);
  const after = await readPriceAndBalance(page);
  const delta = Math.round((before.balance - after.balance) * 100) / 100;
  if (delta === before.price)
    ok(
      `open debited exactly the price: $${before.balance} → $${after.balance}`,
    );
  else fail(`open debited $${delta}, expected $${before.price}`);

  // Vault agrees and the sell-back refills the balance.
  await page.goto(`${BASE}/vault`, { waitUntil: 'domcontentloaded' });
  const sellBtn = page.getByRole('button', { name: /sell for/i }).first();
  await sellBtn.waitFor({ timeout: 20000 });
  await sellBtn.click();
  await page.waitForTimeout(2500);
  const vaultText = await page
    .locator('div', { hasText: /^Credit balance/ })
    .locator('p.font-heading')
    .first()
    .textContent();
  const vaultBalance = Number(vaultText.replace(/[$,]/g, ''));
  if (vaultBalance > after.balance)
    ok(`sell-back refilled the balance: $${after.balance} → $${vaultBalance}`);
  else fail(`balance did not rise after sell-back ($${vaultBalance})`);
  await page.screenshot({ path: 'docs/research/qa-a2-vault.png' });
  await page.context().close();

  // ── Flow B: insufficient credit on a fresh, unfunded customer ───────────
  const email = `qa-a2-${Date.now()}@test.dev`;
  const reg = await fetch(`${BACKEND}/auth/customer/emailpass/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  }).then((r) => r.json());
  await fetch(`${BACKEND}/store/customers`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-publishable-api-key': PK,
      Authorization: `Bearer ${reg.token}`,
    },
    body: JSON.stringify({ email }),
  });

  const page2 = await (
    await browser.newContext({ viewport: { width: 1440, height: 860 } })
  ).newPage();
  await login(page2, email, PASSWORD);
  await page2.getByRole('button', { name: /open pack/i }).click();
  await page2.getByText(/not enough credits/i).waitFor({ timeout: 15000 });
  await page2
    .getByRole('link', { name: /add credits in your vault/i })
    .waitFor({ timeout: 5000 });
  ok('unfunded open blocked with friendly error + top-up link');
  await page2.screenshot({ path: 'docs/research/qa-a2-insufficient.png' });
  await page2.context().close();
} catch (err) {
  fail(err.message);
} finally {
  await browser.close();
}
