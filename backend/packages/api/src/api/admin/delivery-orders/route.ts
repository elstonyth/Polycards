import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../modules/packs/service';
import { PACKS_MODULE } from '../../../modules/packs';
import { serializeDeliveryOrders } from '../../../modules/packs/delivery-view';
import { parsePaginationParams } from '../../../utils/pagination';
import { coerceIdSearch, coerceStatusFilter } from './validate';

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const customerService = req.scope.resolve(Modules.CUSTOMER);

  const status = coerceStatusFilter(req.query.status);
  // ?q= is an id SUBSTRING search — operators paste the tail of an order id
  // off a packing slip, not the whole `do_01J...` handle.
  const q = coerceIdSearch(req.query.q);
  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  if (q) filter.id = { $like: `%${q}%` };

  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 50, maxLimit: 100 },
  );

  const [orders, total] = await packs.listAndCountDeliveryOrders(filter, {
    order: { created_at: 'DESC' },
    skip: offset,
    take: limit,
  });

  const serialized = await serializeDeliveryOrders(packs, orders);

  // Join customer emails for the admin table.
  const customerIds = [...new Set(orders.map((o) => o.customer_id))];
  const customers = customerIds.length
    ? await customerService.listCustomers(
        { id: customerIds },
        { take: customerIds.length },
      )
    : [];
  const emailById = new Map(customers.map((c) => [c.id, c.email]));

  res.json({
    total,
    offset,
    limit,
    orders: serialized.map((o) => ({
      ...o,
      customer_email: emailById.get(o.customer_id) ?? null,
    })),
  });
}
