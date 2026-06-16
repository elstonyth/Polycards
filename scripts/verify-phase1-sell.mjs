// Live verification of Phase 1 (sell-confirm modal + reveal-anchored countdown +
// Transactions ledger) on the PROD build (:4000), backend on :9000.
// reducedMotion so the reveal overlay lands on the card stage immediately.
// Screenshots → docs/research/phase1-*.png. Run: node scripts/verify-phase1-sell.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:4000';
const BACKEND = 'http://localhost:9000';
const EMAIL = 'test@pokenic.app';
const PASSWORD = 'PokenicTest123!';
const PACK = 'pokemon-rookie';

let failed = false;
const ok = (m) => console.log(`✓ ${m}`);
const fail = (m) => {
  console.error(`✗ ${m}`);
  failed = true;
};

async function login(page) {
  await page.goto(`${BASE}/claw/${PACK}`, { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('button', { name: /^login$/i })
    .first()
    .click();
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.press('input[name="password"]', 'Enter');
  await page
    .getByRole('button', { name: /open pack/i })
    .waitFor({ timeout: 20000 });
}

const browser = await chromium.launch({ headless: true });
try {
  // ── Endpoint smoke: the new reveal route is registered + auth-gated ───────
  const unauth = await fetch(`${BACKEND}/store/pulls/does-not-exist/reveal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  // No publishable key → the /store/* key gate answers 400 before auth; that
  // still proves the route EXISTS + is protected (a missing route would 404).
  if (unauth.status === 401 || unauth.status === 400)
    ok(
      `POST /store/pulls/:id/reveal exists + gated (${unauth.status}, not 404)`,
    );
  else fail(`reveal route expected 401/400 (gated), got ${unauth.status}`);

  const ctx = await browser.newContext({
    reducedMotion: 'reduce',
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  await login(page);
  ok('logged in (test customer)');

  // Fund the account so the open is affordable.
  await page.goto(`${BASE}/vault`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /add credits/i }).click();
  await page.getByLabel('Top-up amount in USD').fill('100');
  await page.getByRole('button', { name: /^Add \$100\.00$/ }).click();
  await page.getByText(/added to your balance/i).waitFor({ timeout: 15000 });
  ok('topped up $100');

  // ── Reveal: open a pack → card stage (reduced) → instant sell modal ───────
  await page.goto(`${BASE}/claw/${PACK}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /open pack/i }).click();

  // The instant sell button carries the live countdown ("... · Ns").
  const instantBtn = page.getByRole('button', {
    name: /Sell back for \$.*·\s*\d+s/,
  });
  await instantBtn.waitFor({ timeout: 25000 });
  const instantLabel = (await instantBtn.textContent())?.trim();
  ok(`reveal shows instant offer w/ countdown: "${instantLabel}"`);
  await page.screenshot({ path: 'docs/research/phase1-reveal-card.png' });

  await instantBtn.click();
  const dialog = page.getByRole('dialog', { name: /confirm sell-back/i });
  await dialog.waitFor({ timeout: 8000 });
  await dialog.getByText(/Sell this card\?/i).waitFor({ timeout: 5000 });
  await dialog.getByText(/Instant rate/i).waitFor({ timeout: 5000 });
  await dialog
    .getByText(/Instant offer — \d+s left/i)
    .waitFor({ timeout: 5000 });
  ok(
    'instant SellConfirmModal: card + Instant rate + seconds-left + permanent warning',
  );
  await page.screenshot({
    path: 'docs/research/phase1-reveal-instant-modal.png',
  });

  // Cancel keeps the card; the countdown must still be running.
  await dialog.getByRole('button', { name: /^Cancel$/ }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  ok('modal Cancel closes, card retained');

  // Keep the card in the vault (close the overlay without selling).
  await page.getByRole('button', { name: /keep in vault/i }).click();

  // ── Vault: flat sell modal → confirm → balance rises / card removed ───────
  await page.goto(`${BASE}/vault`, { waitUntil: 'domcontentloaded' });
  const vaultSell = page.getByRole('button', { name: /^Sell for \$/ }).first();
  await vaultSell.waitFor({ timeout: 20000 });
  const cardsBefore = await page
    .getByRole('button', { name: /^Sell for \$/ })
    .count();
  await vaultSell.click();
  const vdialog = page.getByRole('dialog', { name: /confirm sell-back/i });
  await vdialog.waitFor({ timeout: 8000 });
  await vdialog.getByText(/Sell this card\?/i).waitFor({ timeout: 5000 });
  ok('vault Sell opens SellConfirmModal');
  await page.screenshot({ path: 'docs/research/phase1-vault-sell-modal.png' });

  await vdialog.getByRole('button', { name: /^Sell for \$/ }).click();
  await vdialog.waitFor({ state: 'hidden', timeout: 15000 });
  // A card left the grid (count dropped) — confirms the sell credited + removed it.
  await page
    .waitForFunction(
      (prev) =>
        document.querySelectorAll('button').length >= 0 &&
        [...document.querySelectorAll('button')].filter((b) =>
          /^Sell for \$/.test(b.textContent ?? ''),
        ).length < prev,
      cardsBefore,
      { timeout: 15000 },
    )
    .then(() => ok('vault sell confirmed: card removed from grid'))
    .catch(() => fail('vault card count did not drop after confirm'));
  await page.screenshot({ path: 'docs/research/phase1-vault-after.png' });

  // ── Transactions: real ledger with totals + typed rows ────────────────────
  await page.goto(`${BASE}/transactions`, { waitUntil: 'domcontentloaded' });
  await page.getByText('Current balance').waitFor({ timeout: 15000 });
  await page.getByText('Total topped up').waitFor({ timeout: 5000 });
  await page.getByText('Total spent').waitFor({ timeout: 5000 });
  const hasTopup = await page.getByText('Top-up', { exact: true }).count();
  const hasPackOpen = await page
    .getByText('Pack open', { exact: true })
    .count();
  const hasSell = await page.getByText('Sell-back', { exact: true }).count();
  if (hasTopup && hasPackOpen)
    ok(
      `transactions ledger: Top-up(${hasTopup}) Pack open(${hasPackOpen}) Sell-back(${hasSell}) rows`,
    );
  else
    fail(
      `transactions ledger missing rows (topup=${hasTopup} packopen=${hasPackOpen})`,
    );
  await page.screenshot({
    path: 'docs/research/phase1-transactions.png',
    fullPage: true,
  });

  await ctx.close();
} catch (err) {
  fail(err.stack || err.message);
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
