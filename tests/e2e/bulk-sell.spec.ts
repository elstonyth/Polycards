// Customer bulk sell-back through the storefront UI:
//   a funded customer opens two packs (API setup for speed) → logs into the UI →
//   drives the vault multi-select → "Sell (N)" → confirms → both cards leave the
//   vault and the credit ledger gains two 'buyback' rows.
// The single-card sell-back is covered by customer.spec; this covers the bulk path.
import { test, expect } from '@playwright/test';
import { BASE } from './helpers/constants';
import { api, createCustomer, openPack } from './helpers/api';
import * as sf from './helpers/storefront';

const PACK = 'pokemon-rookie';
// createCustomer() registers every customer with this fixed password.
const PASSWORD = 'PwE2e2026!';

test('customer bulk-sells multiple vaulted cards via the UI', async ({
  page,
}) => {
  // Funded customer holding two vaulted cards (API setup), then log into the UI.
  const cust = await createCustomer(200);
  await openPack(cust.token, PACK); // auto-vaults the pull
  await openPack(cust.token, PACK);
  await sf.login(page, PACK, cust.email, PASSWORD);

  await page.goto(`${BASE}/vault`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /^Select cards$/i }).click();

  // In select mode each card is a button labelled "Select <name>"; clicking one
  // flips its label to "Deselect <name>", so repeatedly click the first
  // remaining "Select …" until all are selected. (The mode toggle now reads
  // "Cancel selection", so it doesn't match this locator.)
  const unselected = page.getByRole('button', { name: /^Select / });
  await expect(unselected).toHaveCount(2);
  while ((await unselected.count()) > 0) {
    await unselected.first().click();
  }

  // Bulk sell → the shared confirm dialog (aria-label "Confirm sell-back").
  await page.getByRole('button', { name: /^Sell \(2\)/ }).click();
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
