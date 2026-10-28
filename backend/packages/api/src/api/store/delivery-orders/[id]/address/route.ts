import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../../modules/packs';
import {
  snapshotAddress,
  deliveryZone,
  isShippableCountry,
  isShippablePostcode,
  SHIPPING_COUNTRIES_MESSAGE,
  postcodeMessage,
  ZONE_SHIPPING_MYR,
  CUSTOMER_STATUS_WORD,
  CUSTOMER_CANCELABLE,
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
  // should have paid. Only Malaysia and Singapore ship; a change of zone
  // (West RM15 / East RM35 / Singapore RM50) changes the rate — refuse both
  // and point at the free cancel path (a cancel refunds the fee, so
  // re-requesting re-prices cleanly).
  if (!isShippableCountry(snapshot.ship_country_code)) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, SHIPPING_COUNTRIES_MESSAGE);
  }
  if (
    !isShippablePostcode(snapshot.ship_postal_code, snapshot.ship_country_code)
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      postcodeMessage(snapshot.ship_country_code),
    );
  }
  // Compares the SAME composite zone the charge used (postcode + state/city),
  // not the postcode alone — otherwise re-pointing a KL-postcode order at a
  // Sabah address would keep the RM15 it paid.
  // Orders that paid no fee (before fees existed, or a free prize before
  // 2026-10-14) may still move to the same or a cheaper zone, but never a
  // dearer one: otherwise one could be re-pointed at Singapore and ship there
  // for nothing.
  const toZone = deliveryZone(
    snapshot.ship_postal_code,
    snapshot.ship_province,
    snapshot.ship_city,
    snapshot.ship_country_code,
  );
  const fromZone = deliveryZone(
    order.ship_postal_code,
    order.ship_province,
    order.ship_city,
    order.ship_country_code,
  );
  if (
    toZone !== fromZone &&
    (order.shipping_fee != null ||
      ZONE_SHIPPING_MYR[toZone] > ZONE_SHIPPING_MYR[fromZone])
  ) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      // Cancel-and-re-request is the customer's fix only while they can still
      // cancel (requested, before the 12am cutoff — delivery.ts
      // CUSTOMER_CANCELABLE); after it, only support can.
      CUSTOMER_CANCELABLE.includes(order.status)
        ? 'That address changes the shipping fee zone — cancel this delivery (the fee is refunded) and request it again with the new address.'
        : 'That address changes the shipping fee zone, which can no longer change for this order — please contact support.',
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
