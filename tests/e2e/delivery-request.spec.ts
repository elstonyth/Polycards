// FIXME(ui-drift, PR #85): waits for the vault 'Select cards' button removed in
// the vault redesign (PR #80/#82 era). Rewrite against the current vault UI.
// Customer ordering flow through the storefront UI:
//   a funded customer opens a pack (API setup for speed) → logs into the UI →
//   drives the vault "select cards to ship" → request delivery → add-address form
//   → submit → and confirms the order is tracked on /orders as 'requested'.
// The admin-side fulfilment (pack → ship) is covered by ship-orders.spec.
import { test, expect } from '@playwright/test';
import { BASE, stamp } from './helpers/constants';
import { createCustomer, openPack } from './helpers/api';
import * as sf from './helpers/storefront';

const PACK = 'pokemon-rookie';
// createCustomer() registers every customer with this fixed password.
const PASSWORD = 'PwE2e2026!';

test.fixme('customer requests delivery of a vaulted card via the UI', async ({
  page,
}) => {
  // Funded customer holding one vaulted card (API setup), then log into the UI.
  const cust = await createCustomer(100);
  await openPack(cust.token, PACK); // auto-vaults the pull
  await sf.login(page, PACK, cust.email, PASSWORD);

  await page.goto(`${BASE}/vault`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /^select cards$/i }).click();
  // In select mode each card is an aria-label "Select <name>" button.
  await page
    .getByRole('button', { name: /^Select / })
    .first()
    .click();
  await page.getByRole('button', { name: /^Request delivery \(/ }).click();

  // A fresh customer has no saved address → the add-address form shows at once.
  const modal = page.getByRole('dialog', { name: 'Request delivery' });
  await modal.locator('input[aria-label="First name"]').fill('Ash');
  await modal.locator('input[aria-label="Last name"]').fill('Ketchum');
  await modal
    .locator('input[aria-label="Address"]')
    .fill(`${stamp()} Pallet Town Rd`);
  await modal.locator('input[aria-label="City"]').fill('Kuala Lumpur');
  await modal.locator('input[aria-label="Postal code"]').fill('50000');
  await modal.locator('input[aria-label="Country code"]').fill('MY');
  await modal.getByRole('button', { name: /save address/i }).click();

  // saveAddress() auto-selects the new address and closes the add-form, which
  // enables the footer submit. Wait for that, then submit.
  const submit = modal.getByRole('button', {
    name: 'Request delivery',
    exact: true,
  });
  await expect(submit).toBeEnabled({ timeout: 15_000 });
  await submit.click();
  // Success fires onSubmitted → the modal closes. Wait for that BEFORE navigating
  // (otherwise the goto aborts the in-flight requestDelivery server action).
  await expect(modal).toBeHidden({ timeout: 15_000 });

  // Tracked on the orders page.
  await page.goto(`${BASE}/orders`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByText(/requested/i).first()).toBeVisible({
    timeout: 15_000,
  });
});
