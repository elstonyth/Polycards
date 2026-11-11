import { ContainerRegistrationKeys } from '@medusajs/framework/utils';
import type { MedusaContainer } from '@medusajs/framework/types';
import {
  adjustCardStock,
  takeCardStock,
  CardStockTakeError,
} from '../card-stock';

/**
 * takeCardStock — the production wiring around planCardStockTake (#430/#468
 * follow-up). planCardStockTake itself is pinned pure in
 * card-stock-plan.unit.spec.ts; nothing there imports takeCardStock, so a
 * revert of its loop back to the old single-location body
 * (`adjustInventory(levels[0].…, -qty)`) left every existing spec green. This
 * file drives the REAL cardInventoryLevels -> planCardStockTake ->
 * adjustCardStock chain through a fake container, so that revert fails here.
 *
 * The container fake resolves BY KEY, same shape as
 * gateway-deposit.unit.spec.ts's harness() — cardInventoryLevels resolves
 * ContainerRegistrationKeys.QUERY and calls query.graph(), and takeCardStock
 * adjustCardStock resolves PG_CONNECTION for its one UPDATE. The row shape fed
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
  // (item, location, delta) per UPDATE, read off the bindings adjustCardStock
  // sends: [delta, delta (raw twin), item, location].
  const adjust = jest.fn().mockResolvedValue(undefined);
  const pg = {
    raw: jest.fn(async (_sql: string, b: unknown[]) => {
      await adjust(b[2], b[3], b[0]);
      return { rowCount: 1 };
    }),
  };
  const container = {
    resolve: (key: unknown) => {
      if (key === ContainerRegistrationKeys.QUERY) return query;
      if (key === ContainerRegistrationKeys.PG_CONNECTION) return pg;
      throw new Error(`harness: unexpected resolve(${String(key)})`);
    },
  } as unknown as MedusaContainer;
  return { query, adjust, pg, container };
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
    // The bug this pins: the old body adjusted ONCE, for the
    // whole qty, at whichever location happened to resolve first.
    expect(h.adjust).toHaveBeenCalledTimes(2);
    expect(h.adjust).toHaveBeenNthCalledWith(
      1,
      'A',
      'loc1',
      -3,
    );
    expect(h.adjust).toHaveBeenNthCalledWith(
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
    expect(h.adjust).not.toHaveBeenCalled();
  });

  it('lets the shortfall land on the last level instead of clamping', async () => {
    const h = harness([productRow('A', [{ locationId: 'loc1', stocked: 2 }])]);

    const result = await takeCardStock(h.container)('handle', 5);

    expect(result).toBe(true);
    // The full 5 lands on the only level, not a clamp to the 2 available —
    // the negative counter IS the "units owed" signal (see card-stock.ts).
    expect(h.adjust).toHaveBeenCalledTimes(1);
    expect(h.adjust).toHaveBeenCalledWith('A', 'loc1', -5);
  });

  it('reports what was actually applied when a mid-plan adjust throws', async () => {
    const h = harness([
      productRow('A', [
        { locationId: 'loc1', stocked: 3 },
        { locationId: 'loc2', stocked: 2 },
      ]),
    ]);
    h.adjust
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

describe('adjustCardStock', () => {
  const containerWith = (rowCount: number) => {
    const raw = jest.fn().mockResolvedValue({ rowCount });
    const container = {
      resolve: (key: unknown) => {
        if (key === ContainerRegistrationKeys.PG_CONNECTION) return { raw };
        throw new Error(`unexpected resolve(${String(key)})`);
      },
    } as unknown as MedusaContainer;
    return { raw, container };
  };

  it('adds the delta in the database, raw twin included', async () => {
    const { raw, container } = containerWith(1);
    await adjustCardStock(container, 'iitem_1', 'sloc_1', -1);
    const [sql, bindings] = raw.mock.calls[0];
    // In place, not a value read earlier: that read is what lost updates.
    expect(sql).toMatch(/stocked_quantity = stocked_quantity \+ \?/);
    expect(sql).toMatch(/raw_stocked_quantity = jsonb_build_object/);
    expect(bindings).toEqual([-1, -1, 'iitem_1', 'sloc_1']);
  });

  it('throws NOT_FOUND when no level matches, like adjustInventory', async () => {
    const { container } = containerWith(0);
    await expect(
      adjustCardStock(container, 'iitem_x', 'sloc_x', 1),
    ).rejects.toThrow(/not found/);
  });

  it('refuses a fractional delta before touching the database', async () => {
    const { raw, container } = containerWith(1);
    await expect(
      adjustCardStock(container, 'iitem_1', 'sloc_1', 0.5),
    ).rejects.toThrow(/whole number/);
    expect(raw).not.toHaveBeenCalled();
  });
});
