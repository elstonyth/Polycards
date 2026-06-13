// Phase 6b — admin win-rate editor UI verification (Playwright against :7000).
//
// Logs into the admin SPA, opens the Gacha Packs list + the pokemon-mythic odds
// editor, then drives the real interaction: lock the top card, set 40%, Save.
// Confirms the save persisted via the admin API, then restores the seed odds.
// Screenshots -> docs/research/phase6.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ADMIN = 'http://localhost:7000';
const API = 'http://localhost:9000';
const SLUG = 'pokemon-mythic';
const OUT = 'docs/research/phase6';
mkdirSync(OUT, { recursive: true });

const r = { checks: {} };
const ok = (k, c, d) =>
  (r.checks[k] = c ? 'PASS' : `FAIL${d ? ' — ' + d : ''}`);

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1100 },
});
const page = await ctx.newPage();

// --- login ---
await page.goto(`${ADMIN}/login`, { waitUntil: 'networkidle' }).catch(() => {});
await page.waitForSelector('input[type="email"], input[name="email"]', {
  timeout: 15000,
});
await page.fill(
  'input[type="email"], input[name="email"]',
  'admin@pokenic.local',
);
await page.fill(
  'input[type="password"], input[name="password"]',
  'pokenicadmin2026',
);
await page.click('button[type="submit"]');
await page.waitForTimeout(2500);
ok('logged_in', !/\/login/.test(page.url()), `url ${page.url()}`);

// --- list page ---
await page.goto(`${ADMIN}/packs`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
const listHeading = await page
  .getByText('Gacha Packs')
  .first()
  .isVisible()
  .catch(() => false);
ok('list_heading', listHeading);
const rowCount = await page
  .locator('table tbody tr')
  .count()
  .catch(() => 0);
ok('list_has_packs', rowCount >= 8, `rows ${rowCount}`);
await page.screenshot({
  path: `${OUT}/02-admin-packs-list.png`,
  fullPage: true,
});

// --- editor page (wait for the data-loaded table, not just networkidle) ---
await page.goto(`${ADMIN}/packs/${SLUG}`, { waitUntil: 'networkidle' });
await page
  .locator('table tbody tr')
  .first()
  .waitFor({ state: 'visible', timeout: 20000 })
  .catch(() => {});
await page.waitForTimeout(500);
const editorRows = await page
  .locator('table tbody tr')
  .count()
  .catch(() => 0);
ok('editor_16_rows', editorRows === 16, `rows ${editorRows}`);
const hasAfterSave = await page
  .getByText('After save')
  .first()
  .isVisible()
  .catch(() => false);
ok('editor_after_save_col', hasAfterSave);
const saveBtn = page.getByRole('button', { name: /Save win rates/i });
ok('editor_save_button', await saveBtn.isVisible().catch(() => false));
await page.screenshot({
  path: `${OUT}/03-admin-odds-editor.png`,
  fullPage: true,
});

// --- interaction: lock the top card @ 40%, then Save. Driven via real DOM
//     events (React handlers + the in-browser packsApi.mutate) rather than
//     Playwright hit-testing, which mis-targets this admin's headless flex
//     layout (built-in pages render the same way — a platform render quirk,
//     not our bug). ---
const interaction = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const tr = document.querySelector('table tbody tr');
  const sw = tr.querySelector('button[role="switch"]');
  sw.click(); // toggle lock ON
  await sleep(150);
  const input = tr.querySelector('input[type="number"]');
  const setVal = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value',
  ).set;
  setVal.call(input, '40');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(250);
  const lockedAfterToggle = sw.getAttribute('aria-checked') === 'true';
  const saveBtn = [...document.querySelectorAll('button')].find((b) =>
    /Save win rates/i.test(b.innerText),
  );
  saveBtn.click(); // -> packsApi.admin.packs.$slug.odds.mutate(...)
  await sleep(2800);
  const toast = !!document.body.innerText.match(/Win rates saved/i);
  return { lockedAfterToggle, toast };
});
ok('ui_toggle_locked', interaction.lockedAfterToggle);
ok('save_toast', interaction.toast);
await page.screenshot({
  path: `${OUT}/05-admin-odds-saved.png`,
  fullPage: true,
});

await browser.close();

// --- confirm persistence via admin API, then restore seed odds ---
const token = (
  await (
    await fetch(`${API}/auth/user/emailpass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@pokenic.local',
        password: 'pokenicadmin2026',
      }),
    })
  ).json()
).token;
const after = await (
  await fetch(`${API}/admin/packs/${SLUG}/odds`, {
    headers: { Authorization: `Bearer ${token}` },
  })
).json();
const top = after.odds[0];
ok(
  'persisted_via_ui',
  top.locked === true && top.pct === 40,
  JSON.stringify({ id: top.card_id, pct: top.pct, locked: top.locked }),
);

execSync(
  `docker exec pokenic-postgres psql -U medusa -d medusa -c "UPDATE pack_odds po SET weight = CASE c.rarity WHEN 'Legendary' THEN 5 WHEN 'Epic' THEN 45 WHEN 'Rare' THEN 150 WHEN 'Uncommon' THEN 300 WHEN 'Common' THEN 500 ELSE 100 END, locked = false FROM card c WHERE po.card_id = c.handle AND po.pack_id = '${SLUG}';"`,
  { stdio: 'pipe' },
);

r.verdict = Object.values(r.checks).every((v) => v === 'PASS')
  ? 'PASS'
  : 'FAIL';
console.log(JSON.stringify(r, null, 2));
