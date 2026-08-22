import { ContainerRegistrationKeys, Modules } from '@medusajs/framework/utils';
import type { MedusaContainer } from '@medusajs/framework/types';
import { takeCardStock, CardStockTakeError } from '../card-stock';

/**
 * takeCardStock — the production wiring around planCardStockTake (#430/#468
 * follow-up). planCardStockTake itself is pinned pure in
 * card-stock-plan.unit.spec.ts; nothing there imports takeCardStock, so a
 * revert of its loop back to the old single-location body
 * (`adjustInventory(levels[0].…, -qty)`) left every existing spec green. This
 * file drives the REAL cardInventoryLevels -> planCardStockTake ->
 * adjustInventory chain through a fake container, so that revert fails here.
 *
 * The container fake resolves BY KEY, same shape as
 * globepay-deposit.unit.spec.ts's harness() — cardInventoryLevels resolves
 * ContainerRegistrationKeys.QUERY and calls query.graph(), and takeCardStock
 * itself resolves Modules.INVENTORY for adjustInventory. The row shape fed
 * through query.graph() is the nested product/variant/inventory_item/
 * location_levels tree cardInventoryLevels walks — this keeps the real
 * aggregation under test instead of stubbing it away.
 */

type FakeLevel = { locationId: string; stocked: number; reserved?: number };

const productRow = (itemId: string, levels: FakeLevel[]) => ({
  handle: 'handle',
  variants: [
    {
      manage_inventory: true,
      inventory_items: [
        {
          inventory: {
            id: itemId,
            location_levels: levels.map((l) => ({
              location_id: l.locationId,
              stocked_quantity: l.stocked,
              reserved_quantity: l.reserved ?? 0,
            })),
          },
        },
      ],
    },
  ],
});

function harness(rows: ReturnType<typeof productRow>[]) {
  const query = { graph: jest.fn().mockResolvedValue({ data: rows }) };
  const inventory = { adjustInventory: jest.fn().mockResolvedValue(undefined) };
  const container = {
    resolve: (key: unknown) => {
      if (key === ContainerRegistrationKeys.QUERY) return query;
      if (key === Modules.INVENTORY) return inventory;
      throw new Error(`harness: unexpected resolve(${String(key)})`);
    },
  } as unknown as MedusaContainer;
  return { query, inventory, container };
}

describe('takeCardStock', () => {
  it('splits a take across a handle split over two locations', async () => {
    const h = harness([
      productRow('A', [
        { locationId: 'loc1', stocked: 3 },
        { locationId: 'loc2', stocked: 2 },
      ]),
    ]);

    const result = await takeCardStock(h.container)('handle', 4);

    expect(result).toBe(true);
    // The bug this pins: the old body called adjustInventory ONCE, for the
    // whole qty, at whichever location happened to resolve first.
    expect(h.inventory.adjustInventory).toHaveBeenCalledTimes(2);
    expect(h.inventory.adjustInventory).toHaveBeenNthCalledWith(
      1,
      'A',
      'loc1',
      -3,
    );
    expect(h.inventory.adjustInventory).toHaveBeenNthCalledWith(
      2,
      'A',
      'loc2',
      -1,
    );
  });

  it('resolves false and adjusts nothing for an untracked handle', async () => {
    const h = harness([]);

    const result = await takeCardStock(h.container)('handle', 4);

    expect(result).toBe(false);
    expect(h.inventory.adjustInventory).not.toHaveBeenCalled();
  });

  it('lets the shortfall land on the last level instead of clamping', async () => {
    const h = harness([productRow('A', [{ locationId: 'loc1', stocked: 2 }])]);

    const result = await takeCardStock(h.container)('handle', 5);

    expect(result).toBe(true);
    // The full 5 lands on the only level, not a clamp to the 2 available —
    // the negative counter IS the "units owed" signal (see card-stock.ts).
    expect(h.inventory.adjustInventory).toHaveBeenCalledTimes(1);
    expect(h.inventory.adjustInventory).toHaveBeenCalledWith(
      'A',
      'loc1',
      -5,
    );
  });

  it('reports what was actually applied when a mid-plan adjust throws', async () => {
    const h = harness([
      productRow('A', [
        { locationId: 'loc1', stocked: 3 },
        { locationId: 'loc2', stocked: 2 },
      ]),
    ]);
    h.inventory.adjustInventory
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('adjust failed'));

    let caught: unknown;
    try {
      await takeCardStock(h.container)('handle', 4);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CardStockTakeError);
    const err = caught as CardStockTakeError;
    // Only the FIRST take (loc1, -3) actually committed before the throw —
    // the second (loc2, -1) never applied. Without this, the failure looks
    // identical to "nothing was taken" and the counter's true LOW-by-3 state
    // is invisible to the caller.
    expect(err.applied).toEqual([
      { inventoryItemId: 'A', locationId: 'loc1', qty: 3 },
    ]);
    expect(err.plan).toHaveLength(2);
  });
});
