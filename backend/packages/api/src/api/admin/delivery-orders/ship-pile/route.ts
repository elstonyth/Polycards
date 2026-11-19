import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import type { ShipPileResponse } from './types';
import { shipPileView } from './view';

// The alert lists at most this many; `truncated` says there are more.
const MAX_OPEN = 500;

// GET /admin/delivery-orders/ship-pile — orders that left the ship pile
// (ready_to_ship or pending_ship) without shipping, cancelled or stepped back
// to processed, whose parcel nobody has marked pulled yet (incident
// 2026-11-03: the packer was never told, and the parcel went out). The Orders
// page shows these above every tab until the packer presses "Parcel pulled"
// (POST /admin/delivery-orders/:id/ship-pile). delivery_order:read through
// the prefix table (admin-rbac.ts), the same read the Orders page needs.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse<ShipPileResponse>,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const rows = await packs.listShipPileExits({
    openOnly: true,
    limit: MAX_OPEN + 1,
  });
  const entries = rows.slice(0, MAX_OPEN);

  const orderIds = entries.map((e) => e.order_id);
  const staffIds = [
    ...new Set(
      entries.map((e) => e.moved_by).filter((a) => !a.startsWith('system:')),
    ),
  ];
  const [orders, staff] = await Promise.all([
    orderIds.length
      ? packs.listDeliveryOrders(
          { id: orderIds },
          { select: ['id', 'ship_name', 'ship_city'], take: orderIds.length },
        )
      : [],
    staffIds.length
      ? req.scope
          .resolve(Modules.USER)
          .listUsers(
            { id: staffIds },
            { select: ['id', 'email'], take: staffIds.length },
          )
      : [],
  ]);

  res.json({
    open: shipPileView(entries, {
      orders: new Map(orders.map((o) => [o.id, o] as const)),
      staffEmails: new Map(staff.map((u) => [u.id, u.email] as const)),
    }),
    truncated: rows.length > MAX_OPEN,
  });
}
