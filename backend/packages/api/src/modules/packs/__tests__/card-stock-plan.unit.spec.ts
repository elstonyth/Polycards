import { planCardStockTake, type CardStockLevel } from '../card-stock';

/**
 * planCardStockTake — a multi-unit take is split ACROSS a handle's inventory
 * levels (#430).
 *
 * The bug this pins: getCardStockByHandle aggregates stocked − reserved over
 * every location, while the take resolved ONE location and removed the whole
 * qty there. A prize card stocked 3 + 2 across two locations therefore reported
 * 5 available and then took all 4 units out of the location holding 3.
 *
 * Two invariants, and they are the whole file:
 *  - Σ(plan) === qty. Never clamped — the shortfall is the operator's
 *    "units owed to winners" signal and must reach the counter.
 *  - No level gives up more than its OWN available, except the last one, which
 *    deliberately absorbs the remainder (that is where the negative lives).
 */

const level = (id: string, available: number): CardStockLevel => ({
  inventoryItemId: `iitem_${id}`,
  locationId: `loc_${id}`,
  available,
});

const total = (plan: { qty: number }[]) =>
  plan.reduce((sum, p) => sum + p.qty, 0);

describe('planCardStockTake', () => {
  it('spreads a take across split stock instead of over-drawing one location', () => {
    const levels = [level('a', 3), level('b', 2)];
    const plan = planCardStockTake(levels, 4);

    expect(total(plan)).toBe(4);
    expect(plan).toEqual([
      { inventoryItemId: 'iitem_a', locationId: 'loc_a', qty: 3 },
      { inventoryItemId: 'iitem_b', locationId: 'loc_b', qty: 1 },
    ]);
    // The old behaviour — 4 out of the location holding 3 — is exactly what
    // this refuses.
    for (const [i, p] of plan.entries()) {
      expect(p.qty).toBeLessThanOrEqual(levels[i].available);
    }
  });

  it('puts the shortfall on the LAST level rather than clamping the take', () => {
    const plan = planCardStockTake([level('a', 3), level('b', 2)], 8);

    // 3 + 2 available, 8 asked: the counter must move by 8 so the missing 3
    // show up as the units owed.
    expect(total(plan)).toBe(8);
    expect(plan.at(-1)).toEqual({
      inventoryItemId: 'iitem_b',
      locationId: 'loc_b',
      qty: 5,
    });
  });

  it('takes the whole shortfall at the only level when nothing is available', () => {
    const plan = planCardStockTake([level('a', 0)], 2);
    expect(plan).toEqual([
      { inventoryItemId: 'iitem_a', locationId: 'loc_a', qty: 2 },
    ]);
  });

  it('skips a level whose stock is fully reserved', () => {
    // available = stocked − reserved, the same basis the gate reads — a level
    // with stock that is entirely reserved is not a place to take units from.
    const plan = planCardStockTake([level('a', 0), level('b', 5)], 2);
    expect(plan).toEqual([
      { inventoryItemId: 'iitem_b', locationId: 'loc_b', qty: 2 },
    ]);
  });

  it('never draws from a level that is already negative', () => {
    const plan = planCardStockTake([level('a', -4), level('b', 5)], 3);
    expect(total(plan)).toBe(3);
    expect(plan).toEqual([
      { inventoryItemId: 'iitem_b', locationId: 'loc_b', qty: 3 },
    ]);
  });

  it('plans nothing for an untracked handle or a non-positive take', () => {
    expect(planCardStockTake([], 5)).toEqual([]);
    expect(planCardStockTake([level('a', 3)], 0)).toEqual([]);
  });
});
