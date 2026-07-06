// Admin ship-orders workflow, end to end:
//   a customer requests physical delivery of a vaulted card (set up via API for
//   determinism) → the operator advances it requested → packing → shipped through
//   the Deliveries dashboard → asserted in the UI (the modal closes on success)
//   AND server-side (admin delivery-orders API reports 'shipped').
//
// Backend transitions are sequential (modules/packs/delivery.ts ALLOWED):
//   requested → packing → shipped → delivered, and 'shipped' requires a tracking
//   number. The operator therefore packs first, then ships.
import { test, expect, type Page } from '@playwright/test';
import { stamp } from './helpers/constants';
import {
  createCustomer,
  openPack,
  firstVaultPullId,
  createAddress,
  requestDelivery,
  adminToken,
  adminGetDeliveryOrder,
} from './helpers/api';
import { ensureAdmin } from './helpers/admin';

const PACK = 'pokemon-rookie';

// Advance the delivery order (located by customer email) to `status` via the
// Deliveries modal. Success closes the modal (setDetail(null)); the toast
// auto-dismisses, so the modal-hidden state is the reliable success signal.
async function advance(
  page: Page,
  email: string,
  status: 'packing' | 'shipped',
  tracking?: string,
): Promise<void> {
  const row = page.locator('tbody tr', { hasText: email });
  await row.first().waitFor({ timeout: 20_000 });
  await row.first().getByRole('button', { name: 'Manage' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 15_000 });
  await dialog.getByRole('combobox').click();
  await page.getByRole('option', { name: status }).click();
  if (tracking) {
    await dialog.getByPlaceholder('Required to mark shipped').fill(tracking);
  }
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

test.describe('admin ship-orders workflow', () => {
  test('customer requests delivery → operator packs then ships it', async ({
    page,
  }) => {
    // --- Precondition (API): a fresh customer with one 'requested' delivery order.
    const cust = await createCustomer(100);
    await openPack(cust.token, PACK); // auto-vaults the pull
    const pullId = await firstVaultPullId(cust.token);
    const addressId = await createAddress(
      cust.token,
      `${stamp()} Pallet Town Rd`,
    );
    const orderId = await requestDelivery(cust.token, [pullId], addressId);

    const tok = await adminToken();
    expect((await adminGetDeliveryOrder(tok, orderId)).status).toBe('requested');

    // --- Operator advances it through the Deliveries dashboard UI.
    await ensureAdmin(page, '/deliveries');
    await advance(page, cust.email, 'packing');
    await advance(page, cust.email, 'shipped', `PW-TRK-${stamp()}`);

    // --- Persisted server-side as 'shipped'.
    await expect
      .poll(async () => (await adminGetDeliveryOrder(tok, orderId)).status, {
        timeout: 15_000,
      })
      .toBe('shipped');
  });
});
