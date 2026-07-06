// Admin dashboard (:7000/dashboard) page-object helpers.
import { type Page, expect } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, ADMIN_PASSWORD } from './constants';

// Saved operator session — written by auth.setup.ts, reused by every e2e test.
export const ADMIN_STORAGE = 'tests/e2e/.auth/admin.json';

export async function adminLogin(page: Page): Promise<void> {
  // /auth/user/emailpass rate-limits sign-ins; retry through the short window.
  for (let attempt = 0; attempt < 4; attempt++) {
    await page.goto(`${ADMIN}/login`, { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="email"]', ADMIN_EMAIL);
    await page.fill('input[name="password"]', ADMIN_PASSWORD);
    await page.keyboard.press('Enter');
    try {
      await page.waitForURL((u) => !u.pathname.includes('login'), {
        timeout: 12_000,
      });
      return;
    } catch {
      await page.waitForTimeout(8_000);
    }
  }
  throw new Error('admin login never left the login page (rate-limited?)');
}

// Navigate into the dashboard, logging in only if the saved session didn't carry
// (keeps admin auth calls to ~one for the whole suite).
export async function ensureAdmin(page: Page, path = ''): Promise<void> {
  await page.goto(`${ADMIN}${path}`, { waitUntil: 'domcontentloaded' });
  if (page.url().includes('/login')) await adminLogin(page);
}

// Scope a create/edit modal field by its <Label> text (Medusa Labels carry no
// htmlFor, so getByLabel can't bind — locate the label's flex-col container).
const fieldByLabel = (page: Page, label: string) =>
  page
    .locator('div.flex.flex-col.gap-y-2', {
      has: page.getByText(label, { exact: true }),
    })
    .first();

// Create a pack through the "New pack" modal. Returns nothing; caller asserts.
export async function createPack(
  page: Page,
  pack: { slug: string; title: string; price: number; imageUrl: string },
): Promise<void> {
  await page.goto(`${ADMIN}/packs`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'New pack' }).click();
  // Slug + image-url have unique placeholders; title via label-scoped container.
  await page.getByPlaceholder('legend-pack').fill(pack.slug);
  await page
    .getByPlaceholder('Image URL or /storefront/path.webp')
    .fill(pack.imageUrl);
  await fieldByLabel(page, 'Title').getByRole('textbox').fill(pack.title);
  await fieldByLabel(page, 'Price (USD)')
    .getByRole('spinbutton')
    .fill(String(pack.price));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Pack created.')).toBeVisible({
    timeout: 15_000,
  });
}

// Register an existing inventory product as a gacha card via the "Add from
// inventory" modal. Requires the product to be eligible (not already a card).
export async function registerCardFromInventory(
  page: Page,
  productTitle: string,
  marketValue: number,
): Promise<void> {
  await page.goto(`${ADMIN}/cards`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Add from inventory' }).click();
  await page.getByPlaceholder('Filter products…').fill(productTitle);
  await page.getByRole('button', { name: productTitle }).first().click();
  await fieldByLabel(page, 'Fair-market value (USD)')
    .getByRole('spinbutton')
    .fill(String(marketValue));
  await page.getByRole('button', { name: 'Register card' }).click();
  await expect(page.getByText('Card registered.')).toBeVisible({
    timeout: 15_000,
  });
}

// Edit a card's gacha facts via the cards-list edit modal (locate the row by
// name). Adjusts FMV and the marketplace-listing toggle, then saves.
export async function editCard(
  page: Page,
  cardName: string,
  patch: { marketValue?: number; forSale?: boolean },
): Promise<void> {
  await page.goto(`${ADMIN}/cards`, { waitUntil: 'domcontentloaded' });
  const row = page.locator('tbody tr', { hasText: cardName });
  await row.first().waitFor({ timeout: 20_000 });
  await row.first().getByRole('button', { name: 'Edit' }).click();
  if (patch.marketValue !== undefined) {
    await fieldByLabel(page, 'Fair-market value (USD)')
      .getByRole('spinbutton')
      .fill(String(patch.marketValue));
  }
  if (patch.forSale !== undefined) {
    const sw = page.getByRole('switch'); // only the edit modal has one
    if ((await sw.isChecked()) !== patch.forSale) await sw.click();
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Card updated.')).toBeVisible({
    timeout: 15_000,
  });
}

// Drive the per-pack odds editor so exactly one card (by name) holds 100% of the
// win rate: lock the target at 100, unlock everyone else (their share -> 0). This
// is the same mutation POST /admin/packs/{slug}/odds performs, but through the UI.
export async function forceCardTo100ViaUI(
  page: Page,
  slug: string,
  targetName: string,
): Promise<void> {
  await page.goto(`${ADMIN}/packs/${slug}`, { waitUntil: 'domcontentloaded' });
  const rows = page.locator('tbody tr');
  await rows.first().waitFor({ timeout: 20_000 });
  const count = await rows.count();
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    const name = ((await row.locator('td').first().innerText()) ?? '').trim();
    const sw = row.getByRole('switch');
    const checked = await sw.isChecked();
    const isTarget = name.includes(targetName) || targetName.includes(name);
    if (isTarget) {
      if (!checked) await sw.click();
      await row.getByRole('spinbutton').fill('100');
    } else if (checked) {
      await sw.click();
    }
  }
  await page.getByRole('button', { name: 'Save win rates' }).click();
  await expect(page.getByText('Win rates saved.')).toBeVisible({
    timeout: 15_000,
  });
}
