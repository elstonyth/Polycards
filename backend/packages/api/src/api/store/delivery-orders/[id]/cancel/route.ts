import {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import PacksModuleService from '../../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../../modules/packs';
import { updateDeliveryOrderWorkflow } from '../../../../../workflows/update-delivery-order';
import { serializeDeliveryOrders } from '../../../../../modules/packs/delivery-view';
import {
  CUSTOMER_CANCELABLE,
  customerCancelRefusal,
} from '../../../../../modules/packs/delivery';

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

  // The customer window closes at the 12am cutoff (delivery.ts
  // CUSTOMER_CANCELABLE). This early check gives the quick refusal; the same
  // list is re-checked under the order's lock (allowed_from), which is what
  // stops a cancel racing the 12am run.
  if (!CUSTOMER_CANCELABLE.includes(order.status)) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      customerCancelRefusal(order.status),
    );
  }

  await updateDeliveryOrderWorkflow(req.scope).run({
    input: {
      order_id: id,
      status: 'canceled',
      allowed_from: [...CUSTOMER_CANCELABLE],
    },
  });

  const [refreshed] = await packs.listDeliveryOrders({ id }, { take: 1 });
  const [serialized] = await serializeDeliveryOrders(packs, [refreshed]);
  res.json({ order: serialized });
}
