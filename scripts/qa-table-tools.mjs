// One-off QA: shift-select + sort/search on the admin gacha tables.
// Requires backend :9000 + admin :7000 up, and ADMIN_PW in env or scripts/.dev-logins.
// Screenshots land in docs/research/qa-table-tools-*.png.
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';

function devLogin(key, fallback) {
  if (process.env[key]) return process.env[key];
  const f = 'scripts/.dev-logins';
  if (existsSync(f)) {
    const m = readFileSync(f, 'utf8').match(new RegExp(`^${key}=(.+)$`, 'm'));
    if (m) return m[1].trim();
  }
  return fallback;
}
const BASE = process.env.ADMIN_BASE || 'http://localhost:7000/dashboard';
const EMAIL = devLogin('ADMIN_EMAIL', 'admin@pokenic.app');
const PW = devLogin('ADMIN_PW', '');
if (!PW) {
  console.error('No ADMIN_PW found (env or scripts/.dev-logins)');
  process.exit(1);
}

const OUT = 'docs/research';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();

  // login
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name=email], input[type=email]', {
    timeout: 15000,
  });
  await page.fill('input[name=email], input[type=email]', EMAIL);
  await page.fill('input[name=password], input[type=password]', PW);
  await page.click('button[type=submit]');
  await page.waitForURL((u) => !u.pathname.includes('login'), {
    timeout: 20000,
  });
  console.log('logged in');

  // ── 1. Gacha Cards list: shift-select ─────────────────────────────────────
  await page.goto(`${BASE}/cards`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table tbody tr', { timeout: 20000 });
  const cardRows = page.locator('table tbody tr');
  const nCards = await cardRows.count();
  await cardRows.nth(1).locator('button[role=checkbox]').click();
  await cardRows
    .nth(Math.min(5, nCards - 1))
    .locator('button[role=checkbox]')
    .click({ modifiers: ['Shift'] });
  const bulkText = await page
    .locator('[aria-label="Bulk actions"]')
    .innerText()
    .catch(() => '');
  check(
    'cards shift-select ranges',
    /5 selected/.test(bulkText),
    bulkText.split('\n')[0],
  );
  await page.screenshot({ path: `${OUT}/qa-table-tools-cards.png` });

  // ── 2. Pack odds editor: search + sort + shift-select ────────────────────
  await page.goto(`${BASE}/packs`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('table tbody tr', { timeout: 20000 });
  // Rows navigate via onClick — click the first row's title cell.
  await page.locator('table tbody tr td').nth(1).click();
  await page.waitForURL(/\/packs\/[^/]+$/, { timeout: 20000 });
  await page.waitForSelector('[aria-label="Pack odds table"] tbody tr', {
    timeout: 30000,
  });
  const oddsRows = page.locator('[aria-label="Pack odds table"] tbody tr');
  const nOdds = await oddsRows.count();

  // sort by Value desc, verify first two values ordered
  await page
    .locator('[aria-label="Pack odds table"] thead button', {
      hasText: 'Value',
    })
    .click();
  const parseRm = (s) => Number(s.replace(/[^0-9.]/g, ''));
  const v0 = parseRm(await oddsRows.nth(0).locator('td').nth(4).innerText());
  const v1 = parseRm(await oddsRows.nth(1).locator('td').nth(4).innerText());
  check('pack table sorts by value desc', v0 >= v1, `${v0} >= ${v1}`);

  // shift-select 4 rows under the sort
  await oddsRows.nth(0).locator('button[role=checkbox]').click();
  await oddsRows
    .nth(Math.min(3, nOdds - 1))
    .locator('button[role=checkbox]')
    .click({ modifiers: ['Shift'] });
  const packBulk = await page
    .locator('[aria-label="Bulk actions"]')
    .innerText()
    .catch(() => '');
  check(
    'pack table shift-select ranges',
    /4 selected/.test(packBulk),
    packBulk.split('\n')[0],
  );

  // search narrows + shows count, and drops the selection
  const search = page.locator('input[aria-label="Search name or handle…"]');
  await search.first().fill('a');
  const countText = await page
    .locator('text=/\\d+ of \\d+ cards/')
    .first()
    .innerText()
    .catch(() => '');
  check('pack table search shows filtered count', countText !== '', countText);
  const bulkGone =
    (await page.locator('[aria-label="Bulk actions"]').count()) === 0;
  check('pack table search clears selection', bulkGone);
  await page.screenshot({ path: `${OUT}/qa-table-tools-pack.png` });
  await search.first().fill('');

  // ── 3. Pool modal: table + search + sort + shift-select ──────────────────
  await page.locator('button', { hasText: 'Manage cards' }).click();
  await page.waitForSelector('[role=dialog] table tbody tr', {
    timeout: 20000,
  });
  const dlg = page.locator('[role=dialog]');
  await dlg.locator('button', { hasText: 'Clear all' }).click();
  const poolRows = dlg.locator('table tbody tr');
  const nPool = await poolRows.count();
  // sort by Value desc, verify first two values ordered
  await dlg.locator('thead button', { hasText: 'Value' }).click();
  const p0 = parseRm(await poolRows.nth(0).locator('td').nth(3).innerText());
  const p1 = parseRm(await poolRows.nth(1).locator('td').nth(3).innerText());
  check('pool modal sorts by value desc', p0 >= p1, `${p0} >= ${p1}`);
  // shift-select rows 0..4
  await poolRows.nth(0).locator('button[role=checkbox]').click();
  await poolRows
    .nth(Math.min(4, nPool - 1))
    .locator('button[role=checkbox]')
    .click({ modifiers: ['Shift'] });
  const subtitle = await dlg
    .locator('text=/\\d+ selected/')
    .first()
    .innerText()
    .catch(() => '');
  check(
    'pool modal shift-select ranges',
    /5 selected/.test(subtitle),
    subtitle.slice(0, 80),
  );
  // search
  await dlg.locator('input[type=search]').fill('pikachu');
  const poolCount = await dlg
    .locator('text=/\\d+ of \\d+ cards/')
    .first()
    .innerText()
    .catch(() => '');
  check('pool modal search filters', poolCount !== '', poolCount);
  await page.screenshot({ path: `${OUT}/qa-table-tools-pool.png` });

  const failed = results.filter((r) => !r.ok);
  console.log(
    failed.length === 0
      ? `ALL ${results.length} CHECKS PASS`
      : `${failed.length}/${results.length} FAILED`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  await browser.close();
}
