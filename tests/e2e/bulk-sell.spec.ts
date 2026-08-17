// Customer bulk sell-back through the storefront UI:
//   a funded customer opens two packs (API setup for speed) → logs into the UI →
//   taps "Select All" in the persistent action bar → "Sell 2" → confirms →
//   both cards leave the vault and the credit ledger gains two 'buyback' rows.
// Re-authored 2026-07-14 against the always-on vault (spec 2026-07-14):
// selection has no mode toggle — tiles are always "Select <name>" buttons,
// the persistent action bar carries "Select All" + "Sell N" / "Deliver N".
// The single-card sell-back is covered by customer.spec; this covers the bulk path.
import { test, expect } from '@playwright/test';
import { BASE } from './helpers/constants';
import { api, createCustomer, openPack } from './helpers/api';
import { fundFor, primaryPack } from './helpers/catalog';
import * as sf from './helpers/storefront';

// createCustomer() registers every customer with this fixed password.
const PASSWORD = 'PwE2e2026!';

test('customer bulk-sells multiple vaulted cards via the UI', async ({
  page,
}) => {
  const pack = await primaryPack();
  const PACK = pack.slug;
  // Pre-accept cookie consent (key: src/lib/consent.ts CONSENT_KEY): the fresh-
  // context banner (z-50, bottom-anchored) overlays the action bar's pills and
  // intercepts their clicks; suppressing it also keeps the screenshots clean.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem('polycards.cookie-consent', 'accepted');
    } catch {
      // Cross-origin iframes deny localStorage — only the top frame matters.
    }
  });

  // Funded customer holding two vaulted cards (API setup), then log into the UI.
  const cust = await createCustomer(fundFor(pack, 2));
  await openPack(cust.token, PACK); // auto-vaults the pull
  await openPack(cust.token, PACK);
  await sf.login(page, PACK, cust.email, PASSWORD);

  await page.goto(`${BASE}/vault`, { waitUntil: 'domcontentloaded' });

  // Selection is always on: each tile is an aria-label "Select <name>"
  // button. (?!All\b) keeps the tile locator from matching the bar's
  // "Select All · N selected" button.
  const unselected = page.getByRole('button', { name: /^Select (?!All\b).+/ });
  await expect(unselected).toHaveCount(2);

  // Boss-doc visual evidence: the persistent bar at 0 selected…
  await page.screenshot({
    path: 'docs/research/pw-vault-bar-idle.png',
    fullPage: true,
  });

  // …then one tap on Select All selects every visible card.
  await page.getByRole('button', { name: /^Select All/ }).click();
  await expect(unselected).toHaveCount(0);
  await page.screenshot({
    path: 'docs/research/pw-vault-bar-selected.png',
    fullPage: true,
  });

  // Bulk action bar → the shared confirm dialog (aria-label "Confirm sell-back").
  await page.getByRole('button', { name: /^Sell 2$/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm sell-back' });
  await expect(dialog.getByText(/Sell 2 cards\?/i)).toBeVisible();
  await dialog.getByRole('button', { name: /^Sell for RM/i }).click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });

  // Both cards left the vault → the empty state shows.
  await expect(page.getByText(/your vault is empty/i)).toBeVisible({
    timeout: 15_000,
  });
  await page.screenshot({
    path: 'docs/research/pw-bulk-sell-vault.png',
    fullPage: true,
  });

  // Ground truth: two buyback rows landed on the credit ledger server-side.
  await expect
    .poll(
      async () => {
        const credits = await api<{
          transactions: Array<{ reason: string }>;
        }>('/store/credits', { token: cust.token });
        return credits.transactions.filter((t) => t.reason === 'buyback')
          .length;
      },
      { timeout: 20_000 },
    )
    .toBeGreaterThanOrEqual(2);
});
