// QA the full claw main quest on the PROD build (:4000) + backend (:9000):
//   1. home page sections render with no console errors
//   2. pack detail shows static Pull Odds + Top Hits + Recent Pulls, and the
//      removed Spice Level / Live Odds blocks stay gone
//   3. anonymous demo spin creates NO backend pull
//   4. signup → logout → login round-trip through the header UI
//   5. top-up funds the balance; open debits exactly the pack price
//   6. the open lands in the public recent-pulls feed
//   7. admin odds changes do NOT alter the published storefront Pull Odds
//   8. vault sell-back refills the balance
//   9. backend ledgers record everything: Pull row (status flip + buyback
//      amount via /admin/pulls) and CreditTransactions (topup / pack_open /
//      buyback via /store/credits)
// Headless; screenshots to docs/research/. Run: node scripts/qa-claw-e2e.mjs
import { chromium } from 'playwright';

const BASE = 'http://localhost:4000';
const BACKEND = 'http://localhost:9000';
const PK =
  'pk_a23d4482ee6673a760097f3d013aab59679ceaebab54f987638cbeeb0132863c';
const PACK = 'pokemon-rookie';
const TOPUP = 100;
const STAMP = Date.now();
const EMAIL = `qa-e2e-${STAMP}@pokenic.local`;
const PASSWORD = 'QaE2e2026!';
const ADMIN_EMAIL = 'qa-admin@pokenic.local';
const ADMIN_PASSWORD = 'QaAdmin2026!';
// The statically published odds (packs-data.ts ODDS) — what the page must show
// regardless of the admin-tuned secret weights.
const PUBLISHED_ODDS = [
  ['Legendary', '0.5%'],
  ['Epic', '4.5%'],
  ['Rare', '15%'],
  ['Uncommon', '30%'],
  ['Common', '50%'],
];

const fail = (m) => {
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};
const ok = (m) => console.log(`✓ ${m}`);

const api = async (path, opts = {}) => {
  const res = await fetch(`${BACKEND}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-publishable-api-key': PK,
      ...(opts.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return res.json();
};

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

// CTA footer: "Each open costs $X in site credits — your balance: $Y"
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

const revealDialog = (page) => page.getByRole('dialog', { name: /^opening /i });

// Stage 1 (pack cylinder) wraps the whole screen in a stopPropagation block —
// selection happens via pointer-up ON the grabbable pack, so click that.
async function selectPack(page) {
  const dialog = revealDialog(page);
  await dialog.waitFor({ timeout: 15000 });
  await dialog.locator('div.cursor-grab').click();
}

// Later stages (slab → metadata → pull → card) advance on any click that
// bubbles to the dialog root; tap the top strip, which is always background
// (the inner card stack stops propagation; Close/icons sit in the corners).
async function tapOverlay(page) {
  const dialog = revealDialog(page);
  await dialog.waitFor({ timeout: 15000 });
  const box = await dialog.boundingBox();
  await dialog.click({ position: { x: box.width / 2, y: 60 } });
}

// Reveal theater: cylinder → tap pack → slab → tap → metadata → card → keep.
async function playRevealAndKeep(page) {
  await page.waitForTimeout(2600);
  await selectPack(page);
  await page.waitForTimeout(1000);
  await tapOverlay(page);
  const keep = page.getByRole('button', { name: /keep in vault/i });
  await keep.waitFor({ timeout: 25000 });
  await keep.click();
  await page.waitForTimeout(800);
}

// Demo theater (no keep button — demo result has Spin again instead).
async function playDemoToCard(page) {
  await page.getByRole('button', { name: /demo spin/i }).click();
  await page.waitForTimeout(1200);
  await selectPack(page);
  await page.waitForTimeout(900);
  await tapOverlay(page);
  await page.waitForTimeout(600);
  await tapOverlay(page);
  await page.getByText('Demo', { exact: true }).waitFor({ timeout: 25000 });
  await page.waitForTimeout(1000);
}

const browser = await chromium.launch({ headless: true });

try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });

  // ── 1. Home page ──────────────────────────────────────────────────────────
  await page.goto(BASE, { waitUntil: 'networkidle' });
  for (const section of [/recent pulls/i, /how it works/i, /leaderboard/i]) {
    const hit = await page.getByText(section).first().isVisible();
    if (hit) ok(`home section renders: ${section}`);
    else fail(`home section missing: ${section}`);
  }
  await page.screenshot({ path: 'docs/research/qa-e2e-home.png' });
  if (consoleErrors.length === 0) ok('home page: zero console errors');
  else fail(`home console errors: ${consoleErrors.join(' | ')}`);

  // ── 2. Pack detail: static odds shown, spice/live-odds gone ──────────────
  await page.goto(`${BASE}/claw/${PACK}`, { waitUntil: 'domcontentloaded' });
  if (await page.getByText(/select spice level/i).count())
    fail("'Select Spice Level' still renders");
  else ok("'Select Spice Level' removed");
  if (await page.getByText(/^Live Odds$/i).count())
    fail("'Live Odds' panel still renders");
  else ok("'Live Odds' panel removed");
  for (const [rarity, pct] of PUBLISHED_ODDS) {
    const row = page
      .locator('li', { hasText: rarity })
      .filter({ hasText: pct });
    if (await row.count()) ok(`Pull Odds row: ${rarity} ${pct}`);
    else fail(`Pull Odds row missing: ${rarity} ${pct}`);
  }
  if (
    await page
      .getByText(/top hits/i)
      .first()
      .isVisible()
  )
    ok('Top Hits section renders');
  else fail('Top Hits section missing');
  if (
    await page
      .getByText(/recent pulls/i)
      .first()
      .isVisible()
  )
    ok('Recent Pulls section renders on pack detail');
  else fail('Recent Pulls section missing on pack detail');
  await page.screenshot({
    path: 'docs/research/qa-e2e-detail.png',
    fullPage: true,
  });

  // ── 3. Anonymous demo spin creates no backend pull ────────────────────────
  // The feed is capped at 12, so compare the newest entry, not the length.
  const newest = (pulls) => pulls[0]?.rolled_at ?? null;
  const pullsBefore = (await api('/store/pulls/recent')).pulls ?? [];
  await playDemoToCard(page);
  const pullsAfterDemo = (await api('/store/pulls/recent')).pulls ?? [];
  if (newest(pullsAfterDemo) === newest(pullsBefore))
    ok('demo spin created no backend Pull row');
  else fail('newest backend pull changed after a demo spin');
  await page.keyboard.press('Escape');

  // ── 4. Signup → logout → login through the header UI ─────────────────────
  await page.goto(`${BASE}/claw/${PACK}`, { waitUntil: 'domcontentloaded' });
  await page
    .getByRole('button', { name: /^sign up$/i })
    .first()
    .click();
  await page.fill('input[name="username"]', `qa-e2e-${STAMP}`);
  await page.fill('input[name="email"]', EMAIL);
  await page.fill('input[name="password"]', PASSWORD);
  await page.fill('input[name="confirmPassword"]', PASSWORD);
  await page.getByRole('button', { name: /create account/i }).click();
  await page
    .getByRole('button', { name: /open pack/i })
    .waitFor({ timeout: 20000 });
  ok(`signup via UI works (${EMAIL})`);

  // Logout via the user menu.
  await page.locator('header').getByRole('button').last().click();
  await page.getByRole('menuitem', { name: /log out/i }).click();
  await page
    .getByRole('button', { name: /log in to open/i })
    .waitFor({ timeout: 15000 });
  ok("logout via user menu works (CTA back to 'Log in to open')");

  await login(page, EMAIL, PASSWORD);
  ok('login via UI works after logout');

  // ── 5. Top-up, then open debits exactly the price ─────────────────────────
  await page.goto(`${BASE}/vault`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /add credits/i }).click();
  await page.getByLabel('Top-up amount in USD').fill(String(TOPUP));
  await page.getByRole('button', { name: /^Add \$100\.00$/ }).click();
  await page.getByText(/added to your balance/i).waitFor({ timeout: 15000 });
  ok(`topped up $${TOPUP}`);

  await page.goto(`${BASE}/claw/${PACK}`, { waitUntil: 'domcontentloaded' });
  const before = await readPriceAndBalance(page);
  await page.getByRole('button', { name: /open pack/i }).click();
  await playRevealAndKeep(page);
  const after = await readPriceAndBalance(page);
  const delta = Math.round((before.balance - after.balance) * 100) / 100;
  if (delta === before.price)
    ok(`open debited exactly the price ($${before.price})`);
  else fail(`open debited $${delta}, expected $${before.price}`);

  // ── 6. The open lands in the public recent-pulls feed ─────────────────────
  const pullsAfterOpen = (await api('/store/pulls/recent')).pulls ?? [];
  if (
    newest(pullsAfterOpen) !== null &&
    newest(pullsAfterOpen) !== newest(pullsBefore)
  )
    ok('real open appended to /store/pulls/recent');
  else fail('real open missing from /store/pulls/recent');

  // ── 7. Admin odds changes don't move the published Pull Odds ─────────────
  const { token: adminToken } = await api('/auth/user/emailpass', {
    method: 'POST',
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  const adminHeaders = { Authorization: `Bearer ${adminToken}` };
  const oddsState = await api(`/admin/packs/${PACK}/odds`, {
    headers: adminHeaders,
  });
  const original = oddsState.odds.map((o) => ({
    card_id: o.card_id,
    locked: o.locked,
    pct: o.pct,
    rarity: o.rarity,
  }));
  // Lock the most valuable card at a wild 40% — a change that WOULD be visible
  // if the storefront mirrored live weights. Pick it by market_value rather
  // than relying on the endpoint's sort order.
  const values = oddsState.odds.map((o) => Number(o.market_value) || 0);
  const targetIdx = values.indexOf(Math.max(...values));
  const tweaked = original.map((o, i) =>
    i === targetIdx ? { ...o, locked: true, pct: 40 } : { ...o, locked: false },
  );
  await api(`/admin/packs/${PACK}/odds`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ entries: tweaked }),
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  let oddsStillStatic = true;
  for (const [rarity, pct] of PUBLISHED_ODDS) {
    const row = page
      .locator('li', { hasText: rarity })
      .filter({ hasText: pct });
    if (!(await row.count())) oddsStillStatic = false;
  }
  if (oddsStillStatic)
    ok('published Pull Odds unchanged after admin odds rewrite');
  else fail('published Pull Odds MOVED after admin odds rewrite');
  // Restore the operator's original odds.
  await api(`/admin/packs/${PACK}/odds`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({ entries: original }),
  });
  ok('admin odds restored to the original state');

  // ── 8. Vault sell-back refills the balance ────────────────────────────────
  await page.goto(`${BASE}/vault`, { waitUntil: 'domcontentloaded' });
  const sellBtn = page.getByRole('button', { name: /sell for/i }).first();
  await sellBtn.waitFor({ timeout: 20000 });
  await sellBtn.click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'docs/research/qa-e2e-vault.png' });
  ok('vault sell-back clicked');

  // ── 9. Backend ledgers ────────────────────────────────────────────────────
  // Customer credit ledger: topup, pack_open, buyback must all be recorded.
  const { token: custToken } = await api('/auth/customer/emailpass', {
    method: 'POST',
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const credits = await api('/store/credits', {
    headers: { Authorization: `Bearer ${custToken}` },
  });
  const reasons = (credits.transactions ?? []).map((t) => t.reason);
  for (const reason of ['topup', 'pack_open', 'buyback']) {
    if (reasons.includes(reason)) ok(`credit ledger records '${reason}'`);
    else fail(`credit ledger missing '${reason}' (saw: ${reasons.join(',')})`);
  }

  // Admin pull ledger: our pull exists, bought back, with a buyback amount.
  const adminPulls = await api('/admin/pulls', { headers: adminHeaders });
  const mine = (adminPulls.pulls ?? []).filter(
    (p) => p.customer_email === EMAIL,
  );
  if (mine.length === 1) ok('admin pull ledger shows exactly our pull');
  else fail(`admin pull ledger shows ${mine.length} pulls for ${EMAIL}`);
  const pull = mine[0];
  if (pull) {
    if (pull.status === 'bought_back') ok('pull status flipped to bought_back');
    else fail(`pull status is '${pull.status}', expected bought_back`);
    if (Number(pull.buyback_amount) > 0)
      ok(`buyback amount recorded ($${pull.buyback_amount})`);
    else fail('buyback_amount missing on the pull');
    if (pull.pack_id === PACK && pull.card?.handle)
      ok(`pull records pack (${pull.pack_id}) + card (${pull.card.handle})`);
    else fail('pull missing pack_id/card');
  }

  // ── 10. Final logout ──────────────────────────────────────────────────────
  await page.goto(`${BASE}/claw/${PACK}`, { waitUntil: 'domcontentloaded' });
  await page.locator('header').getByRole('button').last().click();
  await page.getByRole('menuitem', { name: /log out/i }).click();
  await page
    .getByRole('button', { name: /log in to open/i })
    .waitFor({ timeout: 15000 });
  ok('final logout: open CTA gated again');

  await ctx.close();
} catch (err) {
  fail(err.message);
} finally {
  await browser.close();
}
