import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { currentToBuyList } from '../../../../modules/packs/procurement-view';

// GET /admin/procurement/to-buy — the purchasing department's list (spec
// 2026-10-28): every card with Qty to be procured >= 1, the card whose
// longest-waiting order is oldest first. While STOCK_AUTO_ALLOCATION is on it
// is the list the 12am stock run froze (`taken_at`); otherwise live
// (`taken_at: null`) — procurement-view.ts. Plain JSON on purpose: the
// admin's Procurement page reads it today, an in-admin chatbot can read it
// later.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  res.json(await currentToBuyList(req.scope));
}
