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

export type CardStockLevel = {
  inventoryItemId: string;
  locationId: string;
  /** stocked − reserved, the SAME basis getCardStockByHandle aggregates on. */
  available: number;
};

export type CardStockTake = {
  inventoryItemId: string;
  locationId: string;
  /** Units to REMOVE at this level (positive; the caller negates). */
  qty: number;
};

// Every tracked (inventory item, location) level for a handle, in query order.
// Sibling of findCardInventoryTarget, which answers the same question for a
// SINGLE unit; this one is what a multi-unit take needs, because one level's
// stock is not the handle's stock.
export async function cardInventoryLevels(
  container: MedusaContainer,
  handle: string,
): Promise<CardStockLevel[]> {
  const rows = await queryStockRows(container, [handle]);
  const levels: CardStockLevel[] = [];
  for (const row of rows) {
    for (const variant of row.variants ?? []) {
      if (!variant?.manage_inventory) continue;
      for (const item of variant.inventory_items ?? []) {
        const itemId = item?.inventory?.id;
        if (!itemId) continue;
        for (const level of item?.inventory?.location_levels ?? []) {
          if (!level?.location_id) continue;
          levels.push({
            inventoryItemId: itemId,
            locationId: level.location_id,
            available:
              num(level.stocked_quantity) - num(level.reserved_quantity),
          });
        }
      }
    }
  }
  return levels;
}

// Split a take of `qty` units across a handle's levels (#430). The gate reads
// stock AGGREGATED over locations while the take used to hit whichever single
// location happened to have units, so a card split 3+2 across two locations
// could have all 4 units of a settlement prize taken out of the location
// holding 3 — driving that one to −1 while the other kept its 2 untouched.
//
// Each level gives up at most its own available units, in query order, and
// whatever is still unmet lands on the LAST level. That remainder is NOT an
// error and is never clamped: the counter is allowed to go negative, and
// negative is exactly the operator's "units owed to winners" signal
// (2026-07-03). Σ(plan) === qty always, so the aggregate the gate reads moves
// by exactly what was asked for.
//
// Pure — the levels come from cardInventoryLevels — so the arithmetic is
// testable without a container or a database.
export function planCardStockTake(
  levels: CardStockLevel[],
  qty: number,
): CardStockTake[] {
  if (levels.length === 0 || qty <= 0) return [];
  const plan: CardStockTake[] = [];
  let remaining = qty;
  for (const level of levels) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, Math.max(0, level.available));
    if (take <= 0) continue;
    plan.push({
      inventoryItemId: level.inventoryItemId,
      locationId: level.locationId,
      qty: take,
    });
    remaining -= take;
  }
  if (remaining > 0) {
    const last = levels[levels.length - 1];
    const existing = plan.find(
      (p) =>
        p.inventoryItemId === last.inventoryItemId &&
        p.locationId === last.locationId,
    );
    if (existing) existing.qty += remaining;
    else
      plan.push({
        inventoryItemId: last.inventoryItemId,
        locationId: last.locationId,
        qty: remaining,
      });
  }
  return plan;
}

// Thrown by takeCardStock when a multi-level plan fails partway through.
// adjustInventory commits per call on the inventory module's own connection —
// there is no transaction here to roll the already-applied calls back — so a
// mid-plan throw leaves the counter LOW by exactly `applied`'s units, not
// unchanged. `plan` vs `applied` is what lets a catch tell "nothing moved"
// apart from "some of it moved": comparing their lengths (or summed qty) is
// the whole point of carrying both.
export class CardStockTakeError extends Error {
  constructor(
    readonly plan: CardStockTake[],
    readonly applied: CardStockTake[],
    cause: unknown,
  ) {
    super(
      `card stock take applied ${applied.length}/${plan.length} level adjustments: ${String(cause)}`,
    );
  }
}

// Take `qty` units of a card handle out of inventory. `false` = untracked
// product (nothing counted, so the pull must not be earmarked — buyback would
// restore a phantom unit); a TRACKED but empty handle still returns true, since
// the units are owed either way. Unconditional by design: the counter may go
// negative, and negative IS the operator's "units owed" signal. Bound from the
// container because the inventory module is only reachable there; the packs
// module service stays container-free.
export const takeCardStock =
  (container: MedusaContainer) =>
  async (handle: string, qty: number): Promise<boolean> => {
    const levels = await cardInventoryLevels(container, handle);
    if (levels.length === 0) return false;
    const inventory = container.resolve(Modules.INVENTORY);
    const plan = planCardStockTake(levels, qty);
    const applied: CardStockTake[] = [];
    try {
      for (const take of plan) {
        await inventory.adjustInventory(
          take.inventoryItemId,
          take.locationId,
          -take.qty,
        );
        applied.push(take);
      }
    } catch (err) {
      // See CardStockTakeError above — attach the split so the caller's log
      // can say which units actually moved (without this, a partial take is
      // indistinguishable from none).
      throw new CardStockTakeError(plan, applied, err);
    }
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
