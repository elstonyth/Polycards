// Admin Pixel Pokédex UI verification (Playwright against :7000).
// Logs into the admin SPA, opens the new Pixel Pokédex page, screenshots it,
// and confirms it rendered the live library from GET /admin/pixel-pokemon.
import { chromium } from 'playwright';

const ADMIN = process.env.ADMIN_BASE || 'http://localhost:7000/dashboard';
const API = 'http://localhost:9000';
const CREDS = { email: 'admin@pokenic.local', password: 'pokenicadmin2026' };
const r = { checks: {} };
const ok = (k, c, d) =>
  (r.checks[k] = c ? 'PASS' : `FAIL${d ? ' — ' + d : ''}`);

// Ground truth from the API.
const token = (
  await (
    await fetch(`${API}/auth/user/emailpass`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(CREDS),
    })
  ).json()
).token;
const api = await (
  await fetch(`${API}/admin/pixel-pokemon?limit=60`, {
    headers: { Authorization: `Bearer ${token}` },
  })
).json();

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1200 },
});
const page = await ctx.newPage();
const consoleErrors = [];
page.on(
  'console',
  (m) => m.type() === 'error' && consoleErrors.push(m.text().slice(0, 140)),
);

await page
  .goto(`${ADMIN}/login`, { waitUntil: 'domcontentloaded' })
  .catch(() => {});
await page.waitForSelector('input[name="email"]', { timeout: 15000 });
await page.fill('input[name="email"]', CREDS.email);
await page.fill('input[name="password"]', CREDS.password);
await page.click('button[type="submit"]');
await page
  .waitForFunction(() => !/\/login/.test(location.pathname), { timeout: 15000 })
  .catch(() => {});

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
  cards: document.querySelectorAll('[data-testid="pokedex-grid"] > div').length,
  imgs: document.querySelectorAll('.grid img').length,
  hasDex: /#\d+/.test(document.body.innerText),
  hasTypeChips: /All types/i.test(document.body.innerText),
  text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
}));

await page.screenshot({
  path: 'docs/research/pixel-pokedex.png',
  fullPage: true,
});
await browser.close();

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
ok('no_console_errors', consoleErrors.length === 0, consoleErrors.join(' | '));

r.apiTotal = api.total;
r.apiPageRows = api.pixel_pokemon?.length;
r.dom = dom;
r.verdict = Object.values(r.checks).every((v) => v === 'PASS')
  ? 'PASS'
  : 'FAIL';
console.log(JSON.stringify(r, null, 2));
