// Admin Pixel Pokédex UI verification (Playwright against :7000).
// Logs into the admin SPA, opens the new Pixel Pokédex page, screenshots it,
// and confirms it rendered the live library from GET /admin/pixel-pokemon.
// Run: QA_ADMIN_TOTP_SECRET=… node scripts/verify-pixel-pokedex.mjs
import { chromium } from 'playwright';
import {
  adminToken,
  adminUiLogin,
  requireAdminTotp,
} from './lib/admin-sign-in.mjs';

const ADMIN = process.env.ADMIN_BASE || 'http://localhost:7000/dashboard';
const API = 'http://localhost:9000';
const CREDS = {
  email: process.env.PW_ADMIN_EMAIL || 'admin@polycards.local',
  password: process.env.PW_ADMIN_PASSWORD || 'polycardsadmin2026',
};
requireAdminTotp(CREDS.email);
const r = { checks: {} };
const ok = (k, c, d) =>
  (r.checks[k] = c ? 'PASS' : `FAIL${d ? ' — ' + d : ''}`);

// Ground truth from the API.
const token = await adminToken(API, CREDS.email, CREDS.password);
const api = await (
  await fetch(`${API}/admin/pixel-pokemon?limit=60`, {
    headers: { Authorization: `Bearer ${token}` },
  })
).json();

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 1200 },
  });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on(
    'console',
    (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 140)),
  );

  await adminUiLogin(page, ADMIN, CREDS.email, CREDS.password);

  // Nav item must appear in the sidebar (RouteConfig registration), not just be
  // reachable by direct URL — that's what "I don't see it" means.
  const navLink = await page
    .waitForSelector('a[href$="/pixel-pokemon"]', { timeout: 10000 })
    .then(() => true)
    .catch(() => false);

  await page.goto(`${ADMIN}/pixel-pokemon`, { waitUntil: 'domcontentloaded' });
  await page
    .waitForFunction(
      () =>
        /Pixel Pok/i.test(document.body.innerText) &&
        document.querySelectorAll('.grid img').length > 0,
      null,
      { timeout: 20000 },
    )
    .catch(() => {});
  await page.waitForTimeout(1500); // let the sprite gifs paint

  const dom = await page.evaluate(() => ({
    hasTitle: /Pixel Pok/i.test(document.body.innerText),
    cards: document.querySelectorAll('[data-testid="pokedex-grid"] > div')
      .length,
    imgs: document.querySelectorAll('.grid img').length,
    hasDex: /#\d+/.test(document.body.innerText),
    hasTypeChips: /All types/i.test(document.body.innerText),
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
  }));

  await page.screenshot({
    path: 'docs/research/pixel-pokedex.png',
    fullPage: true,
  });

  // Upload flow: the button opens a custom-entry form with the expected fields.
  const uploadBtn = page.getByRole('button', { name: /Upload pixel Pok/i });
  const hasUploadBtn = await uploadBtn.isVisible().catch(() => false);
  await uploadBtn.click().catch(() => {});
  const hasForm = await page
    .waitForSelector('#pp-name', { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  await page.screenshot({
    path: 'docs/research/pixel-pokedex-upload.png',
    fullPage: true,
  });

  ok('upload_button_shown', hasUploadBtn);
  ok('upload_form_opens', hasForm);

  ok('nav_item_in_sidebar', navLink);
  ok('page_title', dom.hasTitle);
  ok(
    'grid_matches_api',
    dom.cards === (api.pixel_pokemon?.length ?? -1),
    `dom ${dom.cards} vs api ${api.pixel_pokemon?.length}`,
  );
  ok('sprites_rendered', dom.imgs > 0, `${dom.imgs} imgs`);
  ok('dex_numbers_shown', dom.hasDex);
  ok('type_filter_shown', dom.hasTypeChips);
  ok(
    'no_console_errors',
    consoleErrors.length === 0,
    consoleErrors.join(' | '),
  );

  r.apiTotal = api.total;
  r.apiPageRows = api.pixel_pokemon?.length;
  r.dom = dom;
  r.verdict = Object.values(r.checks).every((v) => v === 'PASS')
    ? 'PASS'
    : 'FAIL';
  console.log(JSON.stringify(r, null, 2));
} finally {
  await browser.close();
}
