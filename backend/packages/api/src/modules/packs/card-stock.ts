import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import type { MedusaContainer } from '@medusajs/framework/types';

// Physical-stock helpers for gacha cards (Card.handle === Product.handle).
//
// Stock is a FULFILLMENT COUNTER, not a gate: a card with 0 available stays on
// the marketplace, in every pack's pool, and in the roll — the buyback system
// can always fulfill a pull without a physical card. The counter tells the
// operator how many pulls they can still ship physically, and it is allowed to
// go NEGATIVE: every win decrements, so a negative number is the units owed to
// winners that still need sourcing (operator request, 2026-07-03). `null`
// means the product doesn't track inventory at all (= infinite / untracked).

export type CardInventoryTarget = {
  inventoryItemId: string;
  locationId: string;
  stocked: number;
};

type ProductStockRow = {
  handle: string | null;
  variants?: Array<{
    manage_inventory?: boolean | null;
    inventory_items?: Array<{
      inventory?: {
        id?: string | null;
        location_levels?: Array<{
          location_id?: string | null;
          stocked_quantity?: unknown;
          reserved_quantity?: unknown;
        } | null> | null;
      } | null;
    } | null> | null;
  } | null> | null;
};

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const STOCK_FIELDS = [
  'handle',
  'variants.manage_inventory',
  'variants.inventory_items.inventory.id',
  'variants.inventory_items.inventory.location_levels.location_id',
  'variants.inventory_items.inventory.location_levels.stocked_quantity',
  'variants.inventory_items.inventory.location_levels.reserved_quantity',
];

async function queryStockRows(
  container: MedusaContainer,
  handles: string[],
): Promise<ProductStockRow[]> {
  if (handles.length === 0) return [];
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const { data } = await query.graph({
    entity: 'product',
    fields: STOCK_FIELDS,
    filters: { handle: handles },
  });
  return data as ProductStockRow[];
}

// Available physical units per handle: Σ(stocked − reserved) over the tracked
// variants' location levels. NOT floored — a negative value is real signal
// (units owed to winners that still need sourcing). `null` when nothing is
// tracked. Handles with no matching product are simply absent from the map.
export async function getCardStockByHandle(
  container: MedusaContainer,
  handles: string[],
): Promise<Map<string, number | null>> {
  const rows = await queryStockRows(container, handles);
  const stockByHandle = new Map<string, number | null>();

  for (const row of rows) {
    if (!row.handle) continue;
    let tracked = false;
    let available = 0;
    for (const variant of row.variants ?? []) {
      if (!variant?.manage_inventory) continue;
      for (const item of variant.inventory_items ?? []) {
        for (const level of item?.inventory?.location_levels ?? []) {
          if (!level) continue;
          tracked = true;
          available +=
            num(level.stocked_quantity) - num(level.reserved_quantity);
        }
      }
    }
    stockByHandle.set(row.handle, tracked ? available : null);
  }
  return stockByHandle;
}

// Take `qty` units of a card handle out of inventory. `false` = untracked
// product (nothing counted, so the pull must not be earmarked — buyback would
// restore a phantom unit). Unconditional by design: the counter may go
// negative, and negative IS the operator's "units owed" signal. Bound from the
// container because the inventory module is only reachable there; the packs
// module service stays container-free.
export const takeCardStock =
  (container: MedusaContainer) =>
  async (handle: string, qty: number): Promise<boolean> => {
    const target = await findCardInventoryTarget(container, handle);
    if (!target) return false;
    await container
      .resolve(Modules.INVENTORY)
      .adjustInventory(target.inventoryItemId, target.locationId, -qty);
    return true;
  };

// The (inventory item, location) pair a pull decrements for a card — the first
// tracked level with stock left, else the first tracked level (so the caller
// can tell "tracked but empty" from "untracked"). `null` = untracked.
export async function findCardInventoryTarget(
  container: MedusaContainer,
  handle: string,
): Promise<CardInventoryTarget | null> {
  const rows = await queryStockRows(container, [handle]);
  let first: CardInventoryTarget | null = null;

  for (const row of rows) {
    for (const variant of row.variants ?? []) {
      if (!variant?.manage_inventory) continue;
      for (const item of variant.inventory_items ?? []) {
        const itemId = item?.inventory?.id;
        if (!itemId) continue;
        for (const level of item?.inventory?.location_levels ?? []) {
          if (!level?.location_id) continue;
          const target: CardInventoryTarget = {
            inventoryItemId: itemId,
            locationId: level.location_id,
            stocked: num(level.stocked_quantity),
          };
          if (target.stocked > 0) return target;
          first ??= target;
        }
      }
    }
  }
  return first;
}
