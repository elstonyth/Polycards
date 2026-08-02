// Admin dashboard (:7000/dashboard) page-object helpers.
import { type Page, expect } from '@playwright/test';
import { ADMIN, ADMIN_EMAIL, ADMIN_PASSWORD } from './constants';

// Saved operator session — written by auth.setup.ts, reused by every e2e test.
export const ADMIN_STORAGE = 'tests/e2e/.auth/admin.json';

export async function adminLogin(page: Page): Promise<void> {
  if (!ADMIN_PASSWORD) {
    throw new Error(
      "PW_ADMIN_PASSWORD is not set — export it to match your stack's seeded admin (see tests/e2e/README.md).",
    );
  }
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
  // Slug placeholder is unique; the image field is targeted by id because the
  // per-pack display-image field (#pack-display-image, PR #163) shares the same
  // "Image URL or /storefront/path.webp" placeholder — getByPlaceholder now
  // matches both. #pack-image is the required main image; display image is
  // optional and left blank here.
  await page.getByPlaceholder('legend-pack').fill(pack.slug);
  await page.locator('#pack-image').fill(pack.imageUrl);
  await fieldByLabel(page, 'Title').getByRole('textbox').fill(pack.title);
  // "Price (RM)" since the MYR localization — the suite predates it and this
  // drift went uncaught while nothing ran these specs in CI.
  await fieldByLabel(page, 'Price (RM)')
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
  await fieldByLabel(page, 'Fair-market value (RM)')
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
    await fieldByLabel(page, 'Fair-market value (RM)')
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
// win rate: lock the target at 100, lock everyone else at 0. This is the same
// mutation POST /admin/packs/{slug}/odds performs, but through the UI.
//
// Locking (not merely unlocking) every other row is load-bearing. The editor's
// preview (odds-rows.ts previewSets -> @acme/odds-math balanceOdds) treats an
// UNLOCKED non-Common row as PINNED to its *tier's own default budget share*
// (routes/packs/[slug]/page.tsx `effective`/`applyTierSplit`), not to 0 — a
// tier's budget is spent independently of what's locked in a DIFFERENT tier.
// So "lock target at 100, unlock the rest" leaves every other tier still
// handing out its full default share on top of the target's 100%, which
// overflows the 100% budget and makes `preview.error` non-null — the Save
// button then stays disabled forever (page.tsx:989 `disabled={... ||
// preview.error !== null}`; there is no separate "dirty" tracking to drive).
// Locking every non-target row at an explicit 0% instead makes every row
// PINNED at a literal value: Σ = 100 (target) + 0×(n-1) = 100 exactly, so
// `balanceOdds` reports no error regardless of the pool's rarity mix — the
// same shape the sibling API-driven test (odds-reflection.spec.ts pack B)
// already sends via `setOdds` (`pct: 0` for every non-target entry).
export async function forceCardTo100ViaUI(
  page: Page,
  slug: string,
  targetName: string,
): Promise<void> {
  await page.goto(`${ADMIN}/packs/${slug}`, { waitUntil: 'domcontentloaded' });
  const rows = page.locator('tbody tr');
  await rows.first().waitFor({ timeout: 20_000 });
  const count = await rows.count();
  let matched = 0;
  for (let i = 0; i < count; i++) {
    const row = rows.nth(i);
    // Cell 1, not cell 0 — cell 0 is the bulk-select checkbox. This read used to
    // be `.first()`, which after that column landed returned '' for every row;
    // `targetName.includes('')` is true, so EVERY row became the target and the
    // helper locked the whole pool at 100% each. Hence the empty-name guard
    // below: an unreadable name must fail loudly, never match everything.
    const name = ((await row.locator('td').nth(1).innerText()) ?? '').trim();
    const sw = row.getByRole('switch');
    const checked = await sw.isChecked();
    const isTarget =
      name !== '' && (name.includes(targetName) || targetName.includes(name));
    if (!checked) await sw.click();
    // Scope to SET 1: locking the row turns Set 2 and Set 3 into number
    // inputs too, so a bare getByRole('spinbutton') is a strict-mode
    // violation. Label is `Set N Win rate (%): <card name>` (i18n
    // packs.editor.set + .winRate) — match the prefix, not the whole string.
    const rateInput = row.getByRole('spinbutton', { name: /^Set 1 / });
    if (isTarget) {
      matched += 1;
      await rateInput.fill('100');
    } else {
      await rateInput.fill('0');
    }
  }
  if (matched !== 1) {
    throw new Error(
      `forceCardTo100ViaUI: expected exactly 1 row matching '${targetName}' in ` +
        `pack '${slug}', matched ${matched} of ${count}. The odds table's column ` +
        `order or aria-labels probably changed.`,
    );
  }
  await page.getByRole('button', { name: 'Save win rates' }).click();
  await expect(page.getByText('Win rates saved.')).toBeVisible({
    timeout: 15_000,
  });
}
