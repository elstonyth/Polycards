import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../../modules/packs/service';
import { PACKS_MODULE } from '../../../../modules/packs';
import { serializeDeliveryOrders } from '../../../../modules/packs/delivery-view';
import { updateDeliveryOrderWorkflow } from '../../../../workflows/update-delivery-order';
import { coerceDeliveryUpdateBody } from '../validate';
import { notifyFeedNonfatal } from '../../../../modules/packs/notify-feed';
import {
  shouldNotifyDeliveryStatus,
  deliveryFeedKey,
} from '../../../../modules/packs/feed-events';

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const { id } = req.params;

  const [order] = await packs.listDeliveryOrders({ id }, { take: 1 });
  if (!order) {
    res.status(404).json({ message: `Delivery order '${id}' not found` });
    return;
  }
  const [serialized] = await serializeDeliveryOrders(packs, [order]);

  const customerService = req.scope.resolve(Modules.CUSTOMER);
  const [customer] = await customerService.listCustomers(
    { id: order.customer_id },
    { take: 1 },
  );

  res.json({
    order: { ...serialized, customer_email: customer?.email ?? null },
  });
}

// POST /admin/delivery-orders/:id — advance status and/or set tracking.
export async function POST(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const { id } = req.params;
  const input = coerceDeliveryUpdateBody(req.body);

  // Read BEFORE the workflow. The workflow result carries only
  // { order_id, status }, and a tracking-only update returns the UNCHANGED
  // status — so both the previous status and the owner have to be captured
  // here to decide whether anything notification-worthy happened.
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const [before] = await packs.listDeliveryOrders({ id }, { take: 1 });

  const { result } = await updateDeliveryOrderWorkflow(req.scope).run({
    input: { order_id: id, ...input },
  });

  // The producer lives HERE rather than inside updateDeliveryOrderWorkflow
  // because the customer's own cancel route (POST
  // /store/delivery-orders/:id/cancel) runs the SAME workflow — a
  // workflow-level producer would tell customers about their own
  // cancellations. Non-fatal: the status change is already committed.
  if (before && shouldNotifyDeliveryStatus(before.status, result.status)) {
    // Non-fatal — never fail a committed status change over a notification.
    // The wrapper logs a producer failure (PR #222) instead of swallowing.
    await notifyFeedNonfatal(req.scope, 'admin/delivery-orders', {
      receiverId: before.customer_id,
      template: 'delivery_status',
      data: {
        order_id: result.order_id,
        status: result.status,
        // Mirrors the step's own nextTracking rule: an omitted
        // tracking_number means "unchanged", not "cleared".
        tracking_number:
          input.tracking_number !== undefined
            ? input.tracking_number
            : (before.tracking_number ?? null),
      },
      idempotencyKey: deliveryFeedKey(result.order_id, result.status),
    });
  }

  res.json(result);
}
