import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import {
  runStockAllocation,
  stockAutoAllocationEnabled,
} from '../../../../modules/packs/stock-allocation-run';

// POST /admin/delivery-orders/allocate — the Stock page's Refresh button: open
// orders whose every card is on hand become ready_to_ship now instead of at 12am
// (operator, 2026-11-03). Only that half of the 00:00 job: short requested
// orders stay requested, so those customers can still cancel, and the to-buy
// list stays frozen. Same switch as the job, so "off" still means nothing moves.
export async function POST(
  req: AuthenticatedMedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  if (!stockAutoAllocationEnabled()) {
    res.json({ ready: 0, failed: 0 });
    return;
  }
  const run = await runStockAllocation(req.scope, {
    nightly: false,
    adminId: req.auth_context.actor_id,
  });
  res.json({ ready: run.ready.length, failed: run.failed.length });
}
