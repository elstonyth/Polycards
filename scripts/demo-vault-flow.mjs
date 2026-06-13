// HEADED demo of the full gacha → vault → buyback customer journey, slowed
// down so a human can watch. Run: node scripts/demo-vault-flow.mjs
// Walks: login → open pokemon-black → INSTANT sell-back (92%) → open another →
// "Keep in vault" (hint shows the 82% vault rate) → /vault page → sell from
// the vault → balance updates. Uses the existing stocktest customer.
import { chromium } from 'playwright';

const BASE = 'http://localhost:4000';
const EMAIL = 'stocktest-1@pokenic.local';
const PASSWORD = 'stocktest2026!';

const step = (m) => console.log(`\n▶ ${m}`);
const pause = (page, ms) => page.waitForTimeout(ms);

const browser = await chromium.launch({ headless: false, slowMo: 250 });
const page = await (
  await browser.newContext({ viewport: { width: 1440, height: 860 } })
).newPage();

try {
  step('Opening the Pokemon Black pack page…');
  await page.goto(`${BASE}/claw/pokemon-black`, {
    waitUntil: 'domcontentloaded',
  });
  await pause(page, 1500);

  step(`Logging in as ${EMAIL}…`);
  await page
    .getByRole('button', { name: /^login$/i })
    .first()
    .click();
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.press('input[name="password"]', 'Enter');
  // Logged-in state = the footer CTA flips from "Log in to open" to "Open Pack".
  await page
    .getByRole('button', { name: /open pack/i })
    .waitFor({ timeout: 20000 });
  await pause(page, 1200);

  // Opens charge the credit balance since Task A2 — fund the two $2,500 opens
  // below through the vault's demo top-up panel (mock gateway, no real money).
  step('Adding $5,000 of demo credits (opens are paid now)…');
  await page.goto(`${BASE}/vault`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /add credits/i }).click();
  await page.getByLabel('Top-up amount in USD').fill('5000');
  await page.getByRole('button', { name: /^Add \$5,000\.00$/ }).click();
  await page.getByText(/added to your balance/i).waitFor({ timeout: 15000 });
  await pause(page, 1500);
  await page.goto(`${BASE}/claw/pokemon-black`, {
    waitUntil: 'domcontentloaded',
  });
  await page
    .getByRole('button', { name: /open pack/i })
    .waitFor({ timeout: 20000 });
  await pause(page, 800);

  // Click through the reveal: tap the pack cylinder (select), tap the slab
  // (start the metadata sequence), then the card stage arrives on its own.
  const playReveal = async () => {
    await pause(page, 2600); // let the cylinder shuffle settle
    await page.mouse.click(720, 420); // tap the front pack → slab rises
    await pause(page, 1000);
    await page.mouse.click(720, 420); // tap the slab → metadata → card
    await page
      .getByRole('button', { name: /keep in vault/i })
      .waitFor({ timeout: 25000 });
    await pause(page, 1800); // admire the card
  };

  step('Opening a pack (1 of 2)…');
  await page.getByRole('button', { name: /open pack/i }).click();
  await playReveal();

  step('INSTANT sell-back — the on-the-spot 92% rate…');
  await page.getByRole('button', { name: /sell back for/i }).click();
  await page.getByText(/credited/i).waitFor({ timeout: 15000 });
  await pause(page, 3000); // show the "+$X credited · balance" confirmation

  step('Opening another pack (2 of 2)…');
  await page.getByRole('button', { name: /open another/i }).click();
  await playReveal();

  step(
    'This time: "Keep in vault" (note the 82% vault-rate hint under the buttons)…',
  );
  await pause(page, 2500); // give the viewer time to read the hint line
  await page.getByRole('button', { name: /keep in vault/i }).click();
  await pause(page, 1200);

  step('Visiting the Vault page — balance + the kept card…');
  await page.goto(`${BASE}/vault`, { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('button', { name: /sell for/i })
    .first()
    .waitFor({ timeout: 20000 });
  await pause(page, 3000); // show the stat cards + the vaulted card

  step('Selling the vaulted card from the Vault…');
  await page
    .getByRole('button', { name: /sell for/i })
    .first()
    .click();
  // The card disappears and the balance stat updates in place.
  await page.getByText(/your vault is empty/i).waitFor({ timeout: 15000 });
  await pause(page, 4000);

  step('Done — the vault is empty and the credit balance holds both sales.');
} finally {
  await browser.close();
}
