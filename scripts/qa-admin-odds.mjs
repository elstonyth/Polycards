// One-off QA: admin pack-odds editor — the bulk-retier box tool and the
// set-overflow preview fix. Run from the repo root so @playwright/test resolves:
//   node scripts/qa-admin-odds.mjs
// Reads admin creds from the gitignored scripts/.dev-logins (never printed).
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUT = process.env.QA_OUT ?? ROOT;
const ADMIN = 'http://localhost:7000/dashboard';
const SLUG = process.env.QA_PACK ?? 'bronze-pack';

// Table column order (0-based) — keep in sync with routes/packs/[slug]/page.tsx.
const COL = { CHECK: 0, CARD: 1, RARITY: 2, NOW: 5, SET1: 7, SET2: 8, SET3: 9 };

const creds = Object.fromEntries(
  fs
    .readFileSync(path.join(ROOT, 'scripts/.dev-logins'), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1100 } });
const shot = (name) =>
  page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });

await page.goto(`${ADMIN}/login`, { waitUntil: 'domcontentloaded' });
await page.fill(
  'input[name="email"]',
  creds.ADMIN_EMAIL ?? 'admin@pokenic.app',
);
await page.fill('input[name="password"]', creds.ADMIN_PW ?? '');
await page.press('input[name="password"]', 'Enter');
await page.waitForURL((u) => !u.pathname.endsWith('/login'), {
  timeout: 60000,
});

const table = page.getByRole('region', { name: 'Pack odds table' });
const rows = table.locator('tbody tr');
const open = async () => {
  await page.goto(`${ADMIN}/packs/${SLUG}`, { waitUntil: 'domcontentloaded' });
  await table.waitFor({ state: 'visible', timeout: 60000 });
  await page.waitForTimeout(1500);
};

// Set 1 shows either a derived "x% default" label OR an input when the row is
// locked — read whichever is there, so "did set 1 survive" is never answered by
// an empty string that only means "this cell is a field".
const setCol = async (row, col) => {
  const cell = row.locator('td').nth(col);
  const input = cell.locator('input[type="number"]');
  return (await input.count())
    ? `[input ${await input.inputValue()}]`
    : (await cell.innerText()).replace(/\n/g, ' ');
};

await open();
console.log('pool rows:', await rows.count());
console.log(
  'headers:',
  JSON.stringify(await table.locator('thead th').allInnerTexts()),
);

// ── 1. Box tool: select every card, then set the tier in one action ────────
await page.getByLabel('Select every card').click();
const bulkBar = page.getByRole('region', { name: 'Bulk actions' });
await bulkBar.waitFor({ state: 'visible', timeout: 10000 });
console.log('bulk bar:', (await bulkBar.innerText()).replace(/\n/g, ' | '));
await shot('qa-1-bulk-selected');

await bulkBar.getByLabel('Set rarity').click();
await page.getByRole('option', { name: 'Mythical', exact: true }).click();
await page.waitForTimeout(800);
// A missing/misnamed i18n key renders the RAW key ("packs.editor.bulk.applied"),
// which passes a smoke test but ships gibberish — assert the resolved copy.
const toast = await page
  .locator('[role="status"], [data-sonner-toast], .toast')
  .first()
  .innerText()
  .catch(() => '(no toast found)');
console.log(
  'apply toast:',
  JSON.stringify(toast.split(String.fromCharCode(10)).join(' ')),
);
console.log(
  'tiers after bulk set:',
  JSON.stringify(
    await table.locator('tbody tr td:nth-child(3)').allInnerTexts(),
  ),
);
await shot('qa-2-bulk-applied');

// ── 2. The 41/42 report: an over-budget SET 2 must not blank SET 1 ─────────
// Reload so the (unsaved) bulk retier above can't colour the result.
await open();

// The probe row is the first UNLOCKED one: its SET 1 cell renders as text
// ("x% default"), so it can actually show whether an errored set blanked set 1.
// A locked row's SET 1 is an input and would read the same either way.
let probe = null;
const n = await rows.count();
for (let i = 0; i < n; i++) {
  const cell = rows.nth(i).locator('td').nth(COL.SET1);
  if ((await cell.locator('input[type="number"]').count()) === 0) {
    probe = i;
    break;
  }
}
console.log('probe row (unlocked):', probe);
const derived = rows.nth(probe);
console.log('probe SET 1 before:', await setCol(derived, COL.SET1));

const err = page.locator('[role="alert"]').first();
const set2Of = (i) =>
  rows.nth(i).locator('td').nth(COL.SET2).locator('input[type="number"]');

// This local pool is nearly all balancer, so one card can legitimately take the
// whole 100%. Push TWO set-2 overrides past 100% between them — the same
// "pinned mass exceeds the budget" state the operator hit at scale, with set 1
// left completely valid.
const steps = [
  ['5', '', 'inside the budget'],
  ['15', '', 'still inside'],
  ['19', '', 'just inside the headroom'],
  ['20', '', 'one point past it'],
  ['40', '', 'well past it'],
];
let firstFail = null;
for (const [a, b, note] of steps) {
  await set2Of(0).fill(a);
  await set2Of(1).fill(b);
  await page.waitForTimeout(400);
  const errText = (await err.count())
    ? (await err.innerText()).replace(/\n/g, ' ')
    : null;
  const set1 = await setCol(derived, COL.SET1);
  console.log(
    `set2 row1=${a.padStart(3)} row2=${(b || '—').padStart(3)}  probe SET 1=${set1.padEnd(18)}  err=${errText ? JSON.stringify(errText) : '—'}   (${note})`,
  );
  if (errText && !firstFail) {
    firstFail = `${a}/${b}`;
    // Measure BOTH after the alert mounts: the table shifts down when it
    // appears, so a box captured before insertion would compare against a
    // stale y and always read "not above".
    const errBox = await err.boundingBox().catch(() => null);
    const tBox = await table.boundingBox();
    console.log(
      `  ^ SET 1 still shown: ${set1 !== '—' && set1 !== ''}` +
        `; error above table: ${errBox && tBox ? errBox.y < tBox.y : 'unknown'}`,
    );
    console.log(
      `  "Save win rates" disabled: ${await page
        .getByRole('button', { name: 'Save win rates' })
        .isDisabled()}`,
    );
    await shot('qa-3-set2-overflow');
  }
}
console.log('first failing combination:', firstFail ?? 'none in range');
await shot('qa-3-set2-overflow');

await browser.close();
