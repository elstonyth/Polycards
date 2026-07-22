// Behaviour check for /dashboard/challenge: keyboard disclosure, edits surviving
// a collapse (dense model, not the DOM), summary math, validation still firing.
import { chromium } from 'playwright';

const BASE = 'http://localhost:7001';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const out = [];
const ok = (name, cond, extra = '') =>
  out.push(`${cond ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

await page.goto(`${BASE}/dashboard/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[name="email"]', 'admin@pokenic.app');
await page.fill('input[name="password"]', 'PreviewOnly2026!');
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard/, { timeout: 30000 });
await page.waitForTimeout(2000);
await page.goto(`${BASE}/dashboard/challenge`, {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(4000);

const toggle = page.locator('[data-pc-stage-toggle]').first();
ok(
  'collapsed by default',
  (await toggle.getAttribute('aria-expanded')) === 'false',
);
ok(
  'no rank rows while collapsed',
  (await page.locator('tbody tr').count()) === 0,
);

// Keyboard: focus the disclosure and open it with Enter.
await toggle.focus();
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
ok(
  'opens via keyboard',
  (await toggle.getAttribute('aria-expanded')) === 'true',
);
const panelId = await toggle.getAttribute('aria-controls');
ok('aria-controls resolves', (await page.locator(`#${panelId}`).count()) === 1);

// Edit rank 4 credits, collapse, re-expand: value must come back from `rows`.
const credits = page.getByLabel('Stage 1 rank 4 credits');
await credits.fill('4321');
await page.waitForTimeout(200);
await toggle.click();
await page.waitForTimeout(300);
ok(
  'collapse unmounts the table',
  (await page.locator(`#${panelId}`).count()) === 0,
);
const summary = await page
  .locator('[data-pc-stage-toggle]')
  .first()
  .locator('xpath=../..')
  .innerText();
ok(
  'summary reflects the edit',
  /RM 10321 credits/.test(summary.replace(/\s+/g, ' ')),
  summary.replace(/\s+/g, ' ').slice(0, 90),
);
await toggle.click();
await page.waitForTimeout(300);
ok(
  'edit survived the collapse',
  (await page.getByLabel('Stage 1 rank 4 credits').inputValue()) === '4321',
);

// Validation still mirrors the server: a bad credits value in a COLLAPSED stage
// must still block the save.
await page.getByLabel('Stage 1 rank 4 credits').fill('-5');
await toggle.click();
await page.waitForTimeout(400);
const body = await page.locator('body').innerText();
ok(
  'collapsed-stage error still surfaces',
  /credits must be a number/.test(body),
);
await page.screenshot({ path: 'docs/research/ch-after-error.png' });

// NaN guard on the summary.
await toggle.click();
await page.getByLabel('Stage 1 rank 4 credits').fill('abc');
await toggle.click();
await page.waitForTimeout(300);
const s2 = await page
  .locator('[data-pc-stage-toggle]')
  .first()
  .locator('xpath=../..')
  .innerText();
ok('no RM NaN in summary', !/NaN/.test(s2));

// Partially-configured stage: only configured ranks show, plus the escape hatch.
await toggle.click();
for (const r of [5, 6, 7, 8, 9, 10])
  await page.getByLabel('Stage 1 rank ' + r + ' credits').fill('');
await page.getByLabel('Stage 1 rank 4 credits').fill('1000');
await toggle.click();
await page.waitForTimeout(200);
await toggle.click();
await page.waitForTimeout(400);
const rowsNow = await page.locator('#' + panelId + ' tbody tr').count();
ok('hides unconfigured ranks', rowsNow === 4, 'rows=' + rowsNow);
const showAll = page.getByRole('button', { name: /Show all 10 ranks/ });
ok('show-all escape hatch present', (await showAll.count()) === 1);
await page.screenshot({ path: 'docs/research/ch-after-partial.png' });
await showAll.first().click();
await page.waitForTimeout(300);
ok(
  'show-all reveals every rank',
  (await page.locator('#' + panelId + ' tbody tr').count()) === 10,
);

console.log(out.join('\n'));
await browser.close();
process.exit(out.some((l) => l.startsWith('FAIL')) ? 1 : 0);
