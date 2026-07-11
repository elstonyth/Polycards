import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import PacksModuleService from '../../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../../modules/packs';
import { updateDeliveryOrderWorkflow } from '../../../../../workflows/update-delivery-order';
import { serializeDeliveryOrders } from '../../../../../modules/packs/delivery-view';

// POST /store/delivery-orders/:id/cancel — the customer cancels their OWN
// delivery while it is still pre-ship. The covered pulls flip
// delivering → vaulted via the shared update-delivery-order workflow (which
// owns the transition validation + compensation), so a canceled order returns
// the cards to the vault where they can be kept, showcased, or sold back.
//
// Fills the sim-found dead end: buyback on an out-for-delivery card told the
// customer to "cancel the delivery first", but no customer cancel route existed.
// Once packed-and-shipped an order is no longer self-cancelable — the customer
// contacts support. Auth + write rate-limit come from the wildcard
// `POST /store/delivery-orders/*` middleware in middlewares.ts.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const customerId = req.auth_context.actor_id;
  const { id } = req.params;
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);

  const [order] = await packs.listDeliveryOrders({ id }, { take: 1 });
  // Unknown id and foreign order both 404 — no cross-account leak (mirrors GET).
  if (!order || order.customer_id !== customerId) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, 'Order not found.');
  }

  // Only a pre-ship order is customer-cancelable. Give an actionable message
  // rather than a bare transition error.
  if (order.status !== 'requested' && order.status !== 'packing') {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      order.status === 'canceled'
        ? 'This delivery is already canceled.'
        : `This delivery is already ${order.status} and can no longer be canceled — please contact support.`,
    );
  }

  await updateDeliveryOrderWorkflow(req.scope).run({
    input: { order_id: id, status: 'canceled' },
  });

  const [refreshed] = await packs.listDeliveryOrders({ id }, { take: 1 });
  const [serialized] = await serializeDeliveryOrders(packs, [refreshed]);
  res.json({ order: serialized });
}
