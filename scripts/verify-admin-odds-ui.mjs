// Phase 6b — admin win-rate editor UI verification (Playwright against :7000).
//
// Logs into the admin SPA, opens the Gacha Packs list + the pokemon-mythic odds
// editor, then drives the real interaction: lock the top card, set 40%, Save.
// Confirms the save persisted via the admin API, then restores the seed odds.
// Screenshots -> docs/research/phase6.
// Run: QA_ADMIN_TOTP_SECRET=… node scripts/verify-admin-odds-ui.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import {
  adminToken,
  adminUiLogin,
  requireAdminTotp,
} from './lib/admin-sign-in.mjs';

const ADMIN_EMAIL = 'admin@polycards.local';
const ADMIN_PASSWORD = 'polycardsadmin2026';
requireAdminTotp(ADMIN_EMAIL);

// Admin vite serves under base '/dashboard/' (see apps/admin/vite.config.ts).
const ADMIN = process.env.ADMIN_BASE || 'http://localhost:7000/dashboard';
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

// --- login (two-step: password, then the authenticator code) ---
await adminUiLogin(page, ADMIN, ADMIN_EMAIL, ADMIN_PASSWORD);
ok('logged_in', !/\/(login|sign-in)/.test(page.url()), `url ${page.url()}`);

// --- list page ---
await page.goto(`${ADMIN}/packs`, { waitUntil: 'domcontentloaded' });
// wait for the live-loaded list heading before reading it
await page
  .getByText('Gacha Packs')
  .first()
  .waitFor({ timeout: 15000 })
  .catch(() => {});
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
await page.goto(`${ADMIN}/packs/${SLUG}`, { waitUntil: 'domcontentloaded' });
await page
  .locator('table tbody tr')
  .first()
  .waitFor({ state: 'visible', timeout: 20000 })
  .catch(() => {});
await page.waitForTimeout(500); // render settle — no clean end-signal for all 16 rows mounted
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
// Drive the editor with native Playwright actions scoped to the first row:
// synthetic in-page DOM events no longer move the controlled <input> or the
// Radix switch's React state (React 19), so set them via real click/fill which
// dispatch the events React actually listens for.
const row = page.locator('table tbody tr').first();
const sw = row.locator('button[role="switch"]');
await sw.click();
const lockedAfterToggle = (await sw.getAttribute('aria-checked')) === 'true';
await row.locator('input[type="number"]').first().fill('40');
await page.getByRole('button', { name: /Save win rates/i }).click();
const toast = await page
  .getByText(/Win rates saved/i)
  .first()
  .waitFor({ timeout: 15000 })
  .then(() => true)
  .catch(() => false);
ok('ui_toggle_locked', lockedAfterToggle);
ok('save_toast', toast);
await page.screenshot({
  path: `${OUT}/05-admin-odds-saved.png`,
  fullPage: true,
});

await browser.close();

// --- confirm persistence via admin API, then restore seed odds ---
const token = await adminToken(API, ADMIN_EMAIL, ADMIN_PASSWORD);
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

// rarity lives on pack_odds (denormalised), so restore the seed weights from the
// row's own rarity — the old `FROM card c ... c.rarity` join is stale (card no
// longer carries rarity).
execSync(
  `docker exec pokenic-postgres psql -U medusa -d medusa -c "UPDATE pack_odds SET weight = CASE rarity WHEN 'Legendary' THEN 5 WHEN 'Epic' THEN 45 WHEN 'Rare' THEN 150 WHEN 'Uncommon' THEN 300 WHEN 'Common' THEN 500 ELSE 100 END, locked = false WHERE pack_id = '${SLUG}';"`,
  { stdio: 'pipe' },
);

r.verdict = Object.values(r.checks).every((v) => v === 'PASS')
  ? 'PASS'
  : 'FAIL';
console.log(JSON.stringify(r, null, 2));
