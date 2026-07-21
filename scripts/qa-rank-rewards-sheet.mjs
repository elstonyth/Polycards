// Visual + a11y pass for the ranks 4-10 sheet (plan 057 test plan).
// Usage: serve a build, then PW_BASE=http://localhost:<port> node scripts/qa-rank-rewards-sheet.mjs
// Needs a stage with ranks >=4 configured, and at least one gap rank, to be meaningful.
// NOTE: the trigger lives inside GalleryRail (3D transform) — Playwright cannot
// .click() it ("element is outside of the viewport"); focus + Enter is the way in.
// Asserts the things a screenshot cannot: keyboard reachability, focus trap,
// focus restoration, and that an unconfigured rank is omitted rather than
// rendered blank.
import { chromium } from 'playwright';

const BASE = process.env.PW_BASE ?? 'http://localhost:4200';
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(
    `${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`,
  );
};

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 1100 },
  deviceScaleFactor: 3,
});
await page.goto(`${BASE}/leaderboard`, { waitUntil: 'networkidle' });
const cookie = page.getByRole('button', { name: /^reject$/i }).first();
if (await cookie.isVisible().catch(() => false)) await cookie.click();
await page.waitForTimeout(600);

const trigger = page
  .getByRole('button', { name: /View rewards for ranks 4 to 10/i })
  .first();
await trigger.scrollIntoViewIfNeeded();
await page.waitForTimeout(300);
check('trigger exists and is a button', await trigger.isVisible());

await page
  .locator('section:has-text("Weekly reward stages")')
  .first()
  .screenshot({ path: 'docs/research/ranks-tile-closed.png' });

// Keyboard reachability: focus it directly, then activate with Enter.
await trigger.focus();
check(
  'trigger is keyboard focusable',
  await trigger.evaluate((el) => el === document.activeElement),
);
await page.keyboard.press('Enter');
await page.waitForTimeout(700);

const dialog = page.locator('[role="dialog"]').first();
check('sheet opens via keyboard', await dialog.isVisible().catch(() => false));

await page.screenshot({ path: 'docs/research/ranks-sheet-open.png' });

// Every configured rank present, and the deliberately-empty rank 8 absent.
const text = (await dialog.innerText().catch(() => '')).replace(/\s+/g, ' ');
for (const r of [4, 5, 6, 7, 9, 10]) {
  check(`rank ${r} listed`, new RegExp(`#?${r}\\b`).test(text));
}
check(
  'unconfigured rank 8 omitted',
  !/#8\b/.test(text),
  `sheet text: ${text.slice(0, 160)}`,
);

// Focus trap: tabbing repeatedly must never escape the dialog.
let escaped = false;
for (let i = 0; i < 12; i++) {
  await page.keyboard.press('Tab');
  const inside = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    return !!d && d.contains(document.activeElement);
  });
  if (!inside) {
    escaped = true;
    break;
  }
}
check('focus stays trapped in the sheet', !escaped);

// Escape closes and focus returns to the trigger that opened it.
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
check(
  'escape closes the sheet',
  !(await dialog.isVisible().catch(() => false)),
);
check(
  'focus restored to trigger',
  await trigger
    .evaluate((el) => el === document.activeElement)
    .catch(() => false),
);

const failed = results.filter((r) => !r.pass);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed`,
);
await browser.close();
process.exit(failed.length ? 1 : 0);
