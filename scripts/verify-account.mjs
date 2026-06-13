// Phase 3 account-data slice on :4000.
// Orders: signed-in user with no orders sees the empty state (real backend → []).
// Settings: form prefills from /store/customers/me; profile update round-trips
// (save → backend persists → reload reflects it) and syncs the header menu.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = 'http://localhost:4000';
const OUT = 'docs/research/phase3';
mkdirSync(OUT, { recursive: true });

const email = `acct_${Date.now()}@pokenic.local`;
const username = 'Misty';
const updatedName = 'MistyWaterflower';
const password = 'Sup3rSecret!';
const r = {};

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await ctx.newPage();
const val = (loc) => loc.inputValue().catch(() => '<none>');
const vis = (loc) => loc.isVisible().catch(() => false);

// 1) Sign up a fresh customer (first_name := username).
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'Sign Up' }).first().click();
await page.getByPlaceholder('Username').fill(username);
await page.getByPlaceholder('Email').fill(email);
await page.getByPlaceholder('Password', { exact: true }).fill(password);
await page.getByPlaceholder('Confirm password').fill(password);
await page.getByRole('button', { name: 'Create account' }).click();
await page.waitForTimeout(1500);
r.signedIn = await vis(
  page.getByRole('button', { name: 'Account menu' }).first(),
);

// 2) ORDERS — empty state (no orders exist pre-checkout).
await page.goto(`${BASE}/orders`, { waitUntil: 'networkidle' });
r.ordersEmptyHeading = await vis(
  page.getByRole('heading', { name: 'No orders yet' }),
);
r.ordersCta = await vis(
  page.getByRole('link', { name: 'Browse the marketplace' }),
);
await page.screenshot({ path: `${OUT}/04-orders-empty.png` });

// 3) SETTINGS — form prefilled from the real customer record.
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
const displayName = page.getByRole('textbox', { name: 'Display name' });
const emailField = page.getByRole('textbox', { name: 'Email (read-only)' });
r.settings_displayNamePrefill = await val(displayName);
r.settings_emailPrefill = await val(emailField);
r.settings_emailReadOnly = !(await emailField.isEditable().catch(() => true));
await page.screenshot({ path: `${OUT}/05-settings-prefilled.png` });

// 4) UPDATE profile → save → success note.
await displayName.fill(updatedName);
await page.getByRole('button', { name: 'Save changes' }).click();
await page.waitForTimeout(1500);
r.saveStatus = await page
  .getByRole('status')
  .textContent()
  .catch(() => '<none>');
// Header user-menu reflects the new name without a manual refetch.
r.headerShowsUpdatedName = await vis(
  page.getByText(updatedName, { exact: false }).first(),
);
await page.screenshot({ path: `${OUT}/06-settings-saved.png` });

// 5) RELOAD → the change persisted to the backend (the round-trip proof).
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1000);
r.persistedAfterReload = await val(
  page.getByRole('textbox', { name: 'Display name' }),
);

console.log(JSON.stringify(r, null, 2));
await browser.close();
