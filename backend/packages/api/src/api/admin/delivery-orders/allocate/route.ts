import type {
  AuthenticatedMedusaRequest,
  MedusaResponse,
} from '@medusajs/framework/http';
import {
  runStockAllocation,
  stockAutoAllocationEnabled,
} from '../../../../modules/packs/stock-allocation-run';

// POST /admin/delivery-orders/allocate — the Stock page's Refresh button: open
// orders the stock covers, oldest first, become ready_to_ship now instead of at
// 12am (operator, 2026-11-03). Only that half of the 00:00 job: short requested
// orders stay requested, so those customers can still cancel, and orders placed
// since 12am join the to-buy list only at 12am. Same switch as the job, so "off"
// still means nothing moves.
// shortcut: no time budget, unlike /track. The 12am run clears the backlog, so a
// press is tens of orders at most; add one if a run ever nears Cloudflare's 100 s.
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
