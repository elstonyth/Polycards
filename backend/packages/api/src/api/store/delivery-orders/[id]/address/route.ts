import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../../modules/packs';
import {
  snapshotAddress,
  isEastMalaysiaPostcode,
  CUSTOMER_STATUS_WORD,
} from '../../../../../modules/packs/delivery';

// POST /store/delivery-orders/:id/address — re-snapshot the shipping address
// from the caller's address book, allowed while requested|processed only.
// Locked from ready_to_ship on — a printed label must not diverge from the
// address (mirrors the old requested/packing window).
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context.actor_id;
  const { id } = req.params;
  const body = req.body as { address_id?: unknown } | undefined;
  const addressId = body?.address_id;
  if (typeof addressId !== 'string' || addressId.trim() === '') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      '`address_id` (string) is required.',
    );
  }

  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const [order] = await packs.listDeliveryOrders({ id }, { take: 1 });
  if (!order || order.customer_id !== customerId) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Order not found.');
  }
  // 'packing' = legacy expand-window token (~processed) — stays editable
  // until the contract migration.
  const EDITABLE = ['requested', 'processed', 'packing'];
  if (!EDITABLE.includes(order.status)) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `This order is already ${CUSTOMER_STATUS_WORD[order.status] ?? order.status} — its address can no longer be edited.`,
    );
  }

  const customerModule = req.scope.resolve(Modules.CUSTOMER);
  const [address] = await customerModule.listCustomerAddresses(
    { id: addressId, customer_id: customerId },
    { take: 1 },
  );
  if (!address) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      'Shipping address not found.',
    );
  }
  const snapshot = snapshotAddress(address);
  if (!snapshot) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'That address is missing required shipping fields.',
    );
  }
  // Fee guards (2026-08-25): the shipping fee was charged at request time
  // from the ORIGINAL address, so an edit may not change what the customer
  // should have paid. Non-MY is never shippable; a West<->East zone flip
  // changes the RM15/RM35 rate — refuse both and point at the free cancel
  // path (a cancel refunds the fee, so re-requesting re-prices cleanly).
  // Pre-fee orders (shipping_fee NULL) skip the zone check — nothing was
  // charged, so there is nothing to protect.
  if (snapshot.ship_country_code.trim().toUpperCase() !== 'MY') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'We currently ship within Malaysia only.',
    );
  }
  if (
    order.shipping_fee != null &&
    isEastMalaysiaPostcode(snapshot.ship_postal_code) !==
      isEastMalaysiaPostcode(order.ship_postal_code)
  ) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'That address changes the shipping fee zone — cancel this delivery (the fee is refunded) and request it again with the new address.',
    );
  }
  // Same fallback as request-delivery: addresses saved by the storefront's
  // inline form carry no phone, so pull the profile phone rather than wiping
  // the order's contact number on an address edit.
  if (!snapshot.ship_phone) {
    const [customer] = await customerModule.listCustomers(
      { id: customerId },
      { take: 1 },
    );
    snapshot.ship_phone = customer?.phone ?? null;
  }

  // Atomic write: only update while the order is STILL in the status we read,
  // so an admin shipping the order between our check and this write can't be
  // silently overwritten (0 rows updated → reject).
  const updated = await packs.updateDeliveryOrders({
    selector: {
      id: order.id,
      customer_id: customerId,
      status: order.status,
    },
    data: snapshot,
  });
  if (!updated || updated.length === 0) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      'This order can no longer be edited (its status changed).',
    );
  }
  res.json({ order_id: order.id, address: snapshot });
}
