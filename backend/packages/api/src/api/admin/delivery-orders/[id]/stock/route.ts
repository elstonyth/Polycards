import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { orderStockCover } from '../../../../../modules/packs/stock-allocation-run';

// GET /admin/delivery-orders/:id/stock — which of this order's cards are in
// stock and which are still missing (operator, 2026-11-07: open a processed
// order, see what we have and what to chase). Live and read-only, the same
// oldest-first split the 12am run and the Stock page's Refresh make, so a card
// on the shelf that an older order holds shows as missing here. Gated by
// delivery_order:read through the prefix table (admin-rbac.ts).
// cards null = the order is not waiting on stock (shipped, completed,
// canceled) or does not exist.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  res.json({ cards: await orderStockCover(req.scope, req.params.id) });
}
