import { MedusaRequest, MedusaResponse } from '@medusajs/framework/http';
import { Modules } from '@medusajs/framework/utils';
import PacksModuleService from '../../../modules/packs/service';
import { PACKS_MODULE } from '../../../modules/packs';
import { serializeDeliveryOrders } from '../../../modules/packs/delivery-view';
import {
  parsePaginationParams,
  parseSortParam,
} from '../../../utils/pagination';
import {
  coerceCustomerId,
  coerceIdSearch,
  coerceStatusFilter,
} from './validate';

// Sortable columns are an allowlist, not a passthrough — `order` goes straight
// into the query builder. Real columns only: customer_email, items and the
// nested address are joined/renamed in JS after the page is fetched. Kept to
// exactly the columns the admin table renders a header for — an allowlist wider
// than the UI is surface for nothing.
const SORTABLE = new Set(['created_at', 'status']);

export async function GET(
  req: MedusaRequest,
  res: MedusaResponse,
): Promise<void> {
  const packs: PacksModuleService = req.scope.resolve(PACKS_MODULE);
  const customerService = req.scope.resolve(Modules.CUSTOMER);

  const status = coerceStatusFilter(req.query.status);
  // ?q= is an id SUBSTRING search — operators paste the tail of an order id
  // off a packing slip, not the whole `do_01J...` handle. $ilike, not $like:
  // ULID tails are uppercase and a pasted/retyped id is often lowercased.
  const q = coerceIdSearch(req.query.q);
  // ?customer_id= scopes the table to one player (the player-detail tab).
  const customerId = coerceCustomerId(req.query.customer_id);
  const filter: Record<string, unknown> = {};
  if (status) filter.status = status;
  if (q) filter.id = { $ilike: `%${q}%` };
  if (customerId) filter.customer_id = customerId;

  const { limit, offset } = parsePaginationParams(
    { limit: req.query.limit, offset: req.query.offset },
    { defaultLimit: 50, maxLimit: 100 },
  );

  const { key: sortKey, dir: sortDir } = parseSortParam(
    req.query.sort,
    SORTABLE,
    'created_at',
  );

  // `id` tiebreaker: offset pagination needs a unique secondary sort key or
  // rows sharing a `created_at` (or `status`) can appear on two pages or on
  // neither.
  const [orders, total] = await packs.listAndCountDeliveryOrders(filter, {
    order: { [sortKey]: sortDir, id: sortDir },
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
