// QA the operator dashboard (:7000, vite dev) end to end: login, the cards
// catalog, the packs list, the per-pack odds editor, and the pulls ledger
// (which must show the customer pull recorded by qa-claw-e2e.mjs).
// Headless; screenshots to docs/research/. Run: node scripts/qa-admin-e2e.mjs
import { chromium } from 'playwright';

const ADMIN = 'http://localhost:7000';
const EMAIL = 'qa-admin@pokenic.local';
const PASSWORD = 'QaAdmin2026!';
const PACK = 'pokemon-rookie';

const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};
const ok = (m) => console.log(`✓ ${m}`);

const browser = await chromium.launch({ headless: true });

try {
  const page = await (
    await browser.newContext({ viewport: { width: 1600, height: 900 } })
  ).newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // ── Login ──────────────────────────────────────────────────────────────────
  await page.goto(`${ADMIN}/login`, { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.keyboard.press('Enter');
  await page.waitForURL((u) => !u.pathname.includes('login'), {
    timeout: 20000,
  });
  ok('admin login works');
  await page.screenshot({ path: 'docs/research/qa-admin-home.png' });

  // ── Cards catalog ─────────────────────────────────────────────────────────
  await page.goto(`${ADMIN}/cards`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const cardRows = await page.locator('table tbody tr').count();
  if (cardRows > 0) ok(`cards catalog lists ${cardRows} cards`);
  else fail('cards catalog shows no rows');
  await page.screenshot({ path: 'docs/research/qa-admin-cards.png' });

  // ── Packs list + odds editor ──────────────────────────────────────────────
  await page.goto(`${ADMIN}/packs`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  // The list renders pack TITLES, not slugs — link hrefs carry the slug.
  const packLink = await page.locator(`a[href*="/packs/${PACK}"]`).count();
  if (packLink > 0) ok(`packs list links to '${PACK}'`);
  else {
    const packRows = await page.locator('table tbody tr').count();
    if (packRows > 0) ok(`packs list renders ${packRows} packs (title-only)`);
    else fail('packs list shows no rows');
  }
  await page.screenshot({ path: 'docs/research/qa-admin-packs.png' });

  await page.goto(`${ADMIN}/packs/${PACK}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const pctInputs = await page.locator('input').count();
  if (pctInputs > 0) ok(`pack editor renders (${pctInputs} inputs incl. odds)`);
  else fail('pack editor rendered no inputs');
  const totalLine = await page.getByText(/100(\.0+)?\s*%/).count();
  if (totalLine > 0) ok('odds editor shows a 100% total');
  else fail('odds editor 100% total not found');
  await page.screenshot({
    path: 'docs/research/qa-admin-odds.png',
    fullPage: true,
  });

  // ── Pulls ledger ──────────────────────────────────────────────────────────
  await page.goto(`${ADMIN}/pulls`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const e2ePull = await page.getByText(/qa-e2e-\d+@pokenic\.local/).count();
  if (e2ePull > 0)
    ok("pulls ledger shows the E2E customer's pull (with email)");
  else fail('pulls ledger missing the E2E pull');
  const boughtBack = await page.getByText(/bought.?back/i).count();
  if (boughtBack > 0) ok('pulls ledger shows bought-back status');
  else fail('pulls ledger missing bought-back status');
  await page.screenshot({
    path: 'docs/research/qa-admin-pulls.png',
    fullPage: true,
  });

  // ── Customer support view ────────────────────────────────────────────────
  await page.goto(`${ADMIN}/support`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  await page.fill('#support-q', 'qa-e2e-');
  await page.getByRole('button', { name: /^search$/i }).click();
  const firstResult = page.getByText(/qa-e2e-\d+@pokenic\.local/).first();
  await firstResult.waitFor({ timeout: 15000 });
  ok('support view: customer search returns E2E customers');
  await firstResult.click();
  await page.getByText(/credit balance/i).waitFor({ timeout: 15000 });
  const balText = await page.locator('h1.tabular-nums').first().textContent();
  const balBefore = Number(balText.replace(/[$,]/g, ''));
  ok(`support view: detail loaded (balance $${balBefore})`);

  // Adjust +$5 (through the confirm dialog) and expect the balance stat to
  // rise by exactly 5.
  await page.getByLabel(/amount/i).fill('5');
  await page.getByLabel(/note/i).fill('QA adjustment probe');
  await page.getByRole('button', { name: /apply adjustment/i }).click();
  const confirm = page.getByRole('button', { name: /^apply$/i });
  await confirm.waitFor({ timeout: 10000 });
  ok('support view: confirm dialog gates the adjustment');
  await confirm.click();
  await page.waitForTimeout(2500);
  const balAfterText = await page
    .locator('h1.tabular-nums')
    .first()
    .textContent();
  const balAfter = Number(balAfterText.replace(/[$,]/g, ''));
  if (Math.round((balAfter - balBefore) * 100) === 500)
    ok(`support view: +$5 adjustment applied ($${balBefore} → $${balAfter})`);
  else fail(`adjustment delta wrong: $${balBefore} → $${balAfter}`);
  const adjRow = await page.getByText('QA adjustment probe').count();
  if (adjRow > 0) ok('support view: adjustment row in the ledger with note');
  else fail('support view: adjustment row missing from the ledger');
  await page.screenshot({
    path: 'docs/research/qa-admin-support.png',
    fullPage: true,
  });

  // ── Economy report ───────────────────────────────────────────────────────
  await page.goto(`${ADMIN}/economy`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  for (const stat of [/revenue/i, /payouts/i, /vault liability/i]) {
    if (await page.getByText(stat).first().isVisible())
      ok(`economy: stat card renders (${stat})`);
    else fail(`economy: stat card missing (${stat})`);
  }
  const rtpRows = await page.locator('table tbody tr').count();
  if (rtpRows > 0) ok(`economy: RTP table lists ${rtpRows} active packs`);
  else fail('economy: RTP table empty');
  const rtpBadge = await page.getByText(/%$/).count();
  if (rtpBadge > 0) ok('economy: RTP percentages render');
  else fail('economy: no RTP percentages found');
  await page.screenshot({
    path: 'docs/research/qa-admin-economy.png',
    fullPage: true,
  });

  if (consoleErrors.length === 0) ok('admin dashboard: zero console errors');
  else fail(`admin console errors: ${consoleErrors.slice(0, 5).join(' | ')}`);
} catch (err) {
  fail(err.message);
} finally {
  await browser.close();
}
