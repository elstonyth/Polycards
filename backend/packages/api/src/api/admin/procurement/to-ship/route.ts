import type { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import { PACKS_MODULE } from '../../../../modules/packs';
import type PacksModuleService from '../../../../modules/packs/service';
import { serializeDeliveryOrders } from '../../../../modules/packs/delivery-view';
import { pageAll } from '../../../utils/page-all';

// GET /admin/procurement/to-ship — the mailing department's list (spec
// 2026-10-28): every ready_to_ship order, oldest first, with its address and
// cards. Same serializer as the Orders page, so a parcel reads the same in
// both places.
export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs = req.scope.resolve<PacksModuleService>(PACKS_MODULE);
  const orders = await pageAll(
    (opts) => packs.listDeliveryOrders({ status: 'ready_to_ship' }, opts),
    { created_at: 'ASC', id: 'ASC' },
  );
  const serialized = await serializeDeliveryOrders(packs, orders);

  const customerIds = [...new Set(orders.map((o) => o.customer_id))];
  const customers = customerIds.length
    ? await req.scope
        .resolve(Modules.CUSTOMER)
        .listCustomers({ id: customerIds }, { take: customerIds.length })
    : [];
  const emailById = new Map(customers.map((c) => [c.id, c.email]));

  res.json({
    orders: serialized.map((o) => ({
      ...o,
      customer_email: emailById.get(o.customer_id) ?? null,
    })),
  });
}
