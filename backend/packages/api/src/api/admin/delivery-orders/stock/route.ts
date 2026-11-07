import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { MedusaError } from '@medusajs/framework/utils';
import { ordersStockCover } from '../../../../modules/packs/stock-allocation-run';

// One page of the Orders list (50) plus slack; the allocation runs once anyway.
const MAX_IDS = 100;

// GET /admin/delivery-orders/stock?ids=a,b — which of each order's cards are
// in stock and which are still missing (operator, 2026-11-07: see what we
// have and what to chase, on the list and in Manage). Live and read-only, the
// same oldest-first split the 12am run and the Stock page's Refresh make, so a
// card on the shelf that an older order holds shows as missing here. Gated by
// delivery_order:read through the prefix table (admin-rbac.ts). A null entry
// = the order is not waiting on stock (shipped, completed, canceled) or does
// not exist.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const raw = req.query.ids;
  if (typeof raw !== 'string') {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      'ids must be a comma-separated string.',
    );
  }
  const ids = [
    ...new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (ids.length === 0 || ids.length > MAX_IDS) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `ids must list 1 to ${MAX_IDS} orders.`,
    );
  }
  res.json({ orders: await ordersStockCover(req.scope, ids) });
}
