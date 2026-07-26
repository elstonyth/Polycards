import type { MedusaRequest } from '@medusajs/framework/http';
import type { DeliveryStatus } from '../../../modules/packs/delivery';
import { notifyFeed } from '../../../modules/packs/notify-feed';
import {
  shouldNotifyDeliveryStatus,
  deliveryFeedKey,
} from '../../../modules/packs/feed-events';

// The producer lives HERE rather than inside updateDeliveryOrderWorkflow
// because the customer's own cancel route (POST
// /store/delivery-orders/:id/cancel) runs the SAME workflow — a
// workflow-level producer would tell customers about their own
// cancellations. Non-fatal: the status change is already committed by the
// time this runs, for both the single-order and bulk callers.
export async function notifyDeliveryChange(
  scope: MedusaRequest['scope'],
  before:
    | { status: string; customer_id: string; tracking_number?: string | null }
    | undefined,
  result: { order_id: string; status: DeliveryStatus },
  trackingInput: string | null | undefined,
): Promise<void> {
  if (!before || !shouldNotifyDeliveryStatus(before.status, result.status)) {
    return;
  }
  try {
    await notifyFeed(scope, {
      receiverId: before.customer_id,
      template: 'delivery_status',
      data: {
        order_id: result.order_id,
        status: result.status,
        // Mirrors the step's own nextTracking rule: an omitted
        // tracking_number means "unchanged", not "cleared".
        tracking_number:
          trackingInput !== undefined
            ? trackingInput
            : (before.tracking_number ?? null),
      },
      idempotencyKey: deliveryFeedKey(result.order_id, result.status),
    });
  } catch {
    // Non-fatal — never fail a committed status change over a notification.
  }
}
