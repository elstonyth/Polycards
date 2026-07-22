// Behaviour checks for the decade-grouped VIP ladder.
import { chromium } from 'playwright';
const BASE = 'http://localhost:7001';
const ok = (label, cond, extra = '') =>
  console.log(
    `${cond ? 'PASS' : 'FAIL'} ${label}${extra ? ' :: ' + extra : ''}`,
  );

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(`${BASE}/dashboard/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[name="email"]', 'admin@pokenic.app');
await page.fill('input[name="password"]', 'PreviewOnly2026!');
await page.click('button[type="submit"]');
await page.waitForURL(
  (u) => /dashboard/.test(String(u)) && !/login/.test(String(u)),
  { timeout: 30000 },
);
await page.goto(`${BASE}/dashboard/daily-rewards`, {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(4000);

const details = page.locator('details');
ok(
  '10 decade groups rendered',
  (await details.count()) === 10,
  String(await details.count()),
);

// 1. Keyboard: focus the first summary, press Enter, it expands.
const summary = page.locator('details > summary').first();
await summary.focus();
const focused = await page.evaluate(() => document.activeElement?.tagName);
ok('summary is focusable', focused === 'SUMMARY', String(focused));
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
ok('Enter expands the group', await details.first().evaluate((d) => d.open));
ok(
  'row inputs become visible',
  await page.getByLabel('Level 5 threshold').isVisible(),
);
const expanded = await page.evaluate(() => {
  const d = document.querySelector('details');
  return d ? d.open : null;
});
ok('open state exposed on details (native aria-expanded)', expanded === true);
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
ok('Enter collapses again', !(await details.first().evaluate((d) => d.open)));
ok(
  'row inputs hidden when collapsed',
  !(await page.getByLabel('Level 5 threshold').isVisible()),
);

// 2. A validation error force-opens its decade even after Collapse all.
await page.getByRole('button', { name: 'Expand all' }).click();
await page.waitForTimeout(500);
const orig63 = await page.getByLabel('Level 63 threshold').inputValue();
await page.getByLabel('Level 63 threshold').fill('1');
await page.waitForTimeout(300);
await page.getByRole('button', { name: 'Collapse all' }).click();
await page.waitForTimeout(500);
const openKeys = await page.evaluate(() =>
  Array.from(document.querySelectorAll('details')).map((d) => d.open),
);
ok(
  'only the erroring decade (61-70) stays open',
  JSON.stringify(openKeys) ===
    JSON.stringify([
      false,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
    ]),
  JSON.stringify(openKeys),
);
ok(
  'error is visible',
  await page.getByText(/Level 63: threshold must exceed/).isVisible(),
);
await page.screenshot({ path: 'docs/research/vip-after-error.png' });

// 3. Save serialises the whole ladder, not the expanded decades.
await page.getByRole('button', { name: 'Expand all' }).click();
await page.waitForTimeout(500);
await page.getByLabel('Level 63 threshold').fill(orig63);
// A change with no ordering constraint: the last rung's voucher.
await page.getByLabel('Level 100 voucher').fill('999');
await page.waitForTimeout(300);
let payload = null;
await page.route('**/vip-levels**', async (route) => {
  if (route.request().method() !== 'GET') {
    payload = route.request().postDataJSON();
    await route.abort();
  } else await route.continue();
});
await page.fill('#vip-levels-reason', 'phase B verification');
await page.getByRole('button', { name: 'Save ladder' }).click();
await page.waitForTimeout(1500);
ok(
  'save payload carries all 100 levels',
  payload?.levels?.length === 100,
  JSON.stringify(payload?.levels?.length),
);
ok(
  'levels are 1..100 in order',
  JSON.stringify(payload?.levels?.map((l) => l.level)) ===
    JSON.stringify(Array.from({ length: 100 }, (_, i) => i + 1)),
);
ok(
  'reason forwarded',
  payload?.reason === 'phase B verification',
  String(payload?.reason),
);

await browser.close();
