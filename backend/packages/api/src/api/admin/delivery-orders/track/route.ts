import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { ShipmentTrackerBusy, runShipmentTracker } from '../track-run';

// POST /admin/delivery-orders/track — the Deliveries page's "Check tracking"
// button: the same run as the 2-hourly job, on demand. A 60 s budget keeps
// the request well inside Cloudflare's 100 s; what it doesn't reach waits for
// the next run. Answered here, not thrown: the error handler would swap a
// CONFLICT's message for its generic idempotency text.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  try {
    res.json(
      await runShipmentTracker(req.scope, {
        budgetMs: 60_000,
        actor: req.auth_context.actor_id,
      }),
    );
  } catch (e) {
    if (!(e instanceof ShipmentTrackerBusy)) throw e;
    res.status(409).json({ message: e.message });
  }
}
