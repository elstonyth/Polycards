// Functional check for the shared admin UX layer: dirty state, save gating,
// keyboard reachability of the row-actions menu.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = 'http://localhost:7001';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

await page.goto(`${BASE}/dashboard/login`, { waitUntil: 'domcontentloaded' });
await page.fill('input[name="email"]', 'admin@pokenic.app');
await page.fill('input[name="password"]', 'PreviewOnly2026!');
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard/, { timeout: 30000 });
await page.waitForTimeout(2000);

await page.goto(`${BASE}/dashboard/daily-rewards`, {
  waitUntil: 'domcontentloaded',
});
await page.waitForTimeout(3000);
await page
  .waitForSelector('#vip-levels-reason', { timeout: 20000 })
  .catch(async () => {
    await page.screenshot({ path: 'docs/research/admin-check-fail.png' });
    throw new Error('no reason input');
  });

const saveBtn = page.getByRole('button', { name: 'Save ladder' });
assert.equal(await saveBtn.isDisabled(), true, 'clean form must disable save');
assert.match(
  await page.locator('[aria-live="polite"]').first().innerText(),
  /Saved/,
);

// Dirty it.
const voucher = page.locator('table input').nth(1);
await voucher.fill('7');
await page.waitForTimeout(400);
assert.match(
  await page.locator('[aria-live="polite"]').first().innerText(),
  /Unsaved changes/,
);
assert.equal(
  await saveBtn.isDisabled(),
  true,
  'save stays gated until a reason is given',
);
await page.fill('#vip-levels-reason', 'ux check');
await page.waitForTimeout(300);
assert.equal(await saveBtn.isDisabled(), false, 'dirty + reason enables save');

// Keyboard: focus the first row-actions trigger and open with Enter.
const trigger = page.locator('[aria-label="Actions for VIP level 1"]');
await trigger.focus();
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
await page.keyboard.press('ArrowDown');
const items = await page.getByRole('menuitem').allInnerTexts();
assert.deepEqual(items, [
  'Insert level above',
  'Insert level below',
  'Delete level',
]);
await page.keyboard.press('Escape');

// Hit targets: no interactive control under 32px except switches (by design).
const small = await page.evaluate(() =>
  Array.from(
    document.querySelectorAll(
      '.pc-admin :is(button, input, [role="combobox"]):not([role="switch"])',
    ),
  )
    .filter(
      (e) =>
        e.getBoundingClientRect().height > 0 &&
        e.getBoundingClientRect().height < 32,
    )
    .map((e) => `${e.tagName}.${(e.className || '').toString().slice(0, 40)}`),
);
assert.deepEqual(
  small,
  [],
  `controls under 32px: ${JSON.stringify(small.slice(0, 5))}`,
);

console.log('OK: dirty state, save gating, keyboard menu, 32px floor');
await browser.close();
