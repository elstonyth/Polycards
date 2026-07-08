import type PacksModuleService from './service';
import { pageAll } from '../../api/utils/page-all';

type DeliveryOrderRow = {
  id: string;
  customer_id: string;
  status: string;
  ship_name: string;
  ship_address_1: string;
  ship_address_2: string | null;
  ship_city: string;
  ship_province: string | null;
  ship_postal_code: string;
  ship_country_code: string;
  ship_phone: string | null;
  tracking_number: string | null;
  // Stored via model.json(), so the DML types it as Record<string, unknown> |
  // null; it actually holds a string[]. Coerced with Array.isArray at read.
  proof_images: unknown;
  shipped_at: Date | null;
  delivered_at: Date | null;
  created_at: Date;
};

// Build the response DTO for a set of delivery orders: each order with its
// items resolved to {pull_id, card: {name, image}}. One batched cards fetch.
export async function serializeDeliveryOrders(
  packs: PacksModuleService,
  orders: DeliveryOrderRow[],
) {
  if (orders.length === 0) return [];

  // Paginate to exhaustion — never silently truncate a large batch.
  const orderIds = orders.map((o) => o.id);
  const allItems = await pageAll((opts) =>
    packs.listDeliveryOrderItems({ delivery_order_id: orderIds }, opts),
  );
  const pullIds = [...new Set(allItems.map((i) => i.pull_id))];
  const pulls = pullIds.length
    ? await packs.listPulls({ id: pullIds }, { take: pullIds.length })
    : [];
  const handles = [...new Set(pulls.map((p) => p.card_id))];
  const cards = handles.length
    ? await packs.listCards({ handle: handles }, { take: handles.length })
    : [];

  const cardByHandle = new Map(cards.map((c) => [c.handle, c]));
  const pullById = new Map(pulls.map((p) => [p.id, p]));
  const itemsByOrder = new Map<string, typeof allItems>();
  for (const it of allItems) {
    const arr = itemsByOrder.get(it.delivery_order_id) ?? [];
    arr.push(it);
    itemsByOrder.set(it.delivery_order_id, arr);
  }

  return orders.map((o) => ({
    id: o.id,
    customer_id: o.customer_id,
    status: o.status,
    address: {
      name: o.ship_name,
      address_1: o.ship_address_1,
      address_2: o.ship_address_2,
      city: o.ship_city,
      province: o.ship_province,
      postal_code: o.ship_postal_code,
      country_code: o.ship_country_code,
      phone: o.ship_phone,
    },
    tracking_number: o.tracking_number,
    proof_images: Array.isArray(o.proof_images)
      ? (o.proof_images as string[])
      : [],
    shipped_at: o.shipped_at,
    delivered_at: o.delivered_at,
    created_at: o.created_at,
    items: (itemsByOrder.get(o.id) ?? []).map((it) => {
      const pull = pullById.get(it.pull_id);
      const card = pull ? cardByHandle.get(pull.card_id) : undefined;
      return {
        pull_id: it.pull_id,
        card: card
          ? {
              handle: card.handle,
              name: card.name,
              image: card.image,
              slab_image: card.slab_image ?? null,
            }
          : null,
      };
    }),
  }));
}
