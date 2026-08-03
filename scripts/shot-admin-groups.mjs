// Screenshots the player-group control on the player detail page + the
// Odds Sets page (group -> odds set, create-with-odds-set).
// Run: QA_ADMIN_EMAIL=... QA_ADMIN_PW=... node scripts/shot-admin-groups.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const OUT = process.env.OUT || 'docs/research';
const ADMIN = 'http://localhost:7000/dashboard';
const EMAIL = process.env.QA_ADMIN_EMAIL;
const PW = process.env.QA_ADMIN_PW;

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.goto(`${ADMIN}/login`, { waitUntil: 'domcontentloaded' });
const emailInput = page.locator('input[name="email"]');
await emailInput.waitFor({ state: 'visible', timeout: 30000 });
await emailInput.fill(EMAIL);
await page.fill('input[name="password"]', PW);
await page.press('input[name="password"]', 'Enter');
await page.waitForURL((u) => !String(u).includes('/login'), { timeout: 30000 });
await page.waitForTimeout(3000);

// 1 — Odds Sets: group -> odds set, player counts, create-with-odds-set
await page.goto(`${ADMIN}/odds-sets`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT}/admin-odds-sets.png`, fullPage: true });
console.log('shot: odds-sets');

// 2 — Players list (Group column)
await page.goto(`${ADMIN}/players`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
await page.screenshot({ path: `${OUT}/admin-players-list.png` });
console.log('shot: players list');

// 3 — Player detail, Profile tab: the new Player group card
const row = page.locator('table tbody tr').first();
await row.waitFor({ state: 'visible', timeout: 30000 });
await row.click();
await page.waitForTimeout(6000);
await page.screenshot({
  path: `${OUT}/admin-player-profile.png`,
  fullPage: true,
});
console.log('shot: player profile', page.url());

await browser.close();
