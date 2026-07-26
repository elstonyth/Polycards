import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError, Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../../modules/packs';
import {
  snapshotAddress,
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
  if (order.status !== 'requested' && order.status !== 'processed') {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      `This order is already ${CUSTOMER_STATUS_WORD[order.status]} — its address can no longer be edited.`,
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
