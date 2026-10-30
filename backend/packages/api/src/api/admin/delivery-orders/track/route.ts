import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import { runShipmentTracker } from '../track-run';

// POST /admin/delivery-orders/track — the Deliveries page's "Check tracking"
// button: the same run as the 2-hourly job, on demand.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  res.json(await runShipmentTracker(req.scope));
}
