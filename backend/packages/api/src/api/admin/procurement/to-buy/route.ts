import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { loadInventoryRows } from '../../../../modules/packs/inventory-view';

// GET /admin/procurement/to-buy — the purchasing department's list (spec
// 2026-10-28): every card with Qty to be procured >= 1, the card whose
// longest-waiting order is oldest first. Plain JSON on purpose: the admin's
// Procurement page reads it today, an in-admin chatbot can read it later.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  // Only a card some open order wants can be short, so the rows come from the
  // open orders, not the whole catalogue.
  const orders = await packs.openDeliveryOrdersForAllocation();
  const oldest = new Map<string, Date>();
  for (const o of orders) {
    if (o.status === 'ready_to_ship') continue; // already holds its cards
    for (const h of o.handles) {
      const seen = oldest.get(h);
      if (!seen || o.created_at < seen) oldest.set(h, o.created_at);
    }
  }
  const handles = [...new Set(orders.flatMap((o) => o.handles))];
  const rows = handles.length
    ? await loadInventoryRows(req.scope, { handle: handles })
    : [];

  res.json({
    rows: rows
      .filter((r) => r.to_procure >= 1)
      .map((r) => ({
        handle: r.handle,
        name: r.name,
        sku: r.sku,
        photo: r.photo,
        graded: r.graded,
        to_procure: r.to_procure,
        on_hand: r.on_hand,
        requested: r.requested,
        ready_to_ship: r.ready_to_ship,
        fmv: r.fmv,
        oldest_order_at: oldest.get(r.handle)?.toISOString() ?? null,
      }))
      .sort(
        (a, b) =>
          (a.oldest_order_at ?? '').localeCompare(b.oldest_order_at ?? '') ||
          a.name.localeCompare(b.name),
      ),
  });
}
