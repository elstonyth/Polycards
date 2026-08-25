// Admin ship-orders workflow, end to end:
//   a customer requests physical delivery of a vaulted card (set up via API for
//   determinism) → the operator advances it requested → processed →
//   ready_to_ship → shipped through the All Orders dashboard → asserted in the
//   UI (the modal closes on success) AND server-side (admin delivery-orders API
//   reports 'shipped').
//
// Backend transitions are sequential (modules/packs/delivery.ts ALLOWED):
//   requested → processed → ready_to_ship → shipped → completed, and 'shipped'
//   requires a tracking number. ready_to_ship is a mandatory hop — the operator
//   cannot jump processed → shipped.
//
// The dashboard renders the OPERATOR labels (lib/format.ts
// DELIVERY_STATUS_LABEL), not the raw enum, so the status options are located by
// label ("Ready to ship"), not by token ('ready_to_ship').
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
  topup,
} from './helpers/api';
import { fundFor, primaryPack } from './helpers/catalog';
import { ensureAdmin } from './helpers/admin';

// Operator-facing status labels — what the Manage modal's Select actually
// renders. Keep in step with backend/apps/admin/src/lib/format.ts.
type StatusLabel = 'Processed' | 'Ready to ship' | 'Shipped';

// Advance the delivery order (located by customer email) to `label` via the
// All Orders Manage modal. Success closes the modal (setDetail(null)); the toast
// auto-dismisses, so the modal-hidden state is the reliable success signal.
async function advance(
  page: Page,
  email: string,
  label: StatusLabel,
  tracking?: string,
): Promise<void> {
  const row = page.locator('tbody tr', { hasText: email });
  await row.first().waitFor({ timeout: 20_000 });
  await row.first().getByRole('button', { name: 'Manage' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 15_000 });
  // The modal holds exactly one Select (Status); the bulk bar's lives outside it.
  await dialog.getByRole('combobox').click();
  await page.getByRole('option', { name: label, exact: true }).click();
  if (tracking) {
    await dialog.getByPlaceholder('Required to mark shipped').fill(tracking);
  }
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });
}

test.describe('admin ship-orders workflow', () => {
  test('customer requests delivery → operator processes, readies, ships it', async ({
    page,
  }) => {
    // --- Precondition (API): a fresh customer with one 'requested' delivery order.
    const pack = await primaryPack();
    const cust = await createCustomer(fundFor(pack));
    await openPack(cust.token, pack.slug); // auto-vaults the pull
    const pullId = await firstVaultPullId(cust.token);
    const addressId = await createAddress(
      cust.token,
      `${stamp()} Pallet Town Rd`,
    );
    // Delivery now charges West RM15 + mandatory 5% insurance when the card is
    // worth over RM200 — fundFor's leftover doesn't cover it. RM600 clears the
    // fee for any card the catalog's primary pack can pull (up to ~RM11k value).
    await topup(cust.token, 600);
    const orderId = await requestDelivery(cust.token, [pullId], addressId);

    const tok = await adminToken();
    expect((await adminGetDeliveryOrder(tok, orderId)).status).toBe(
      'requested',
    );

    // --- Operator advances it through the All Orders dashboard UI. Each Save is
    // server-confirmed before the modal closes, so the hops stay ordered.
    await ensureAdmin(page, '/deliveries');
    await advance(page, cust.email, 'Processed');
    await advance(page, cust.email, 'Ready to ship');
    await advance(page, cust.email, 'Shipped', `PW-TRK-${stamp()}`);

    // --- Persisted server-side as 'shipped'.
    await expect
      .poll(async () => (await adminGetDeliveryOrder(tok, orderId)).status, {
        timeout: 15_000,
      })
      .toBe('shipped');
  });
});
