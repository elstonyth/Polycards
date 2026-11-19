import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { shipPileView } from './view';

// GET /admin/delivery-orders/ship-pile — orders cancelled while they sat in
// the ship pile (ready_to_ship or pending_ship) whose parcel nobody has marked
// pulled yet (incident 2026-11-03: the packer was never told, and the
// parcel went out). The Orders page shows these above every tab until the
// packer presses "Parcel pulled" (POST /admin/delivery-orders/:id/ship-pile).
// delivery_order:read through the prefix table (admin-rbac.ts), the same read
// the Orders page itself needs.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const entries = await packs.listShipPileCancels({ openOnly: true });

  const orderIds = entries.map((e) => e.order_id);
  const orders = orderIds.length
    ? await packs.listDeliveryOrders(
        { id: orderIds },
        { select: ['id', 'ship_name', 'ship_city'], take: orderIds.length },
      )
    : [];
  const customerIds = [...new Set(entries.map((e) => e.customer_id))];
  const customers = customerIds.length
    ? await req.scope
        .resolve(Modules.CUSTOMER)
        .listCustomers(
          { id: customerIds },
          { select: ['id', 'email'], take: customerIds.length },
        )
    : [];
  const staffIds = [
    ...new Set(
      entries.map((e) => e.canceled_by).filter((a) => !a.startsWith('system:')),
    ),
  ];
  const staff = staffIds.length
    ? await req.scope
        .resolve(Modules.USER)
        .listUsers(
          { id: staffIds },
          { select: ['id', 'email'], take: staffIds.length },
        )
    : [];

  res.json({
    open: shipPileView(entries, {
      orders: new Map(orders.map((o) => [o.id, o])),
      customerEmails: new Map(customers.map((c) => [c.id, c.email])),
      staffEmails: new Map(staff.map((u) => [u.id, u.email])),
    }),
  });
}
