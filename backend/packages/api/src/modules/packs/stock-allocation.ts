// Which open delivery orders can ship, given the cards physically on hand
// (spec 2026-10-28). Pure: the runner (stock-allocation-run.ts) loads the
// inputs and moves the statuses.
//
// Strict oldest-first (operator decision): ready_to_ship orders keep the units
// they already hold; then every open order, oldest first, takes what it can.
// An order whose every unit is covered is `ready`. One that is not stays
// `short` but STILL holds the units it got, so a newer order for the same card
// waits behind it instead of jumping the queue.

export type AllocOrder = {
  id: string;
  status: string;
  created_at: Date;
  /** One entry per pull in the order, so a card ordered twice appears twice. */
  handles: string[];
};

/** Order ids, oldest first. */
export type AllocResult = { ready: string[]; short: string[] };

// 'packing' is the pre-rename token for 'processed' (delivery.ts ALLOWED).
const OPEN = new Set(['requested', 'processed', 'packing']);

const countUnits = (handles: string[]): Map<string, number> => {
  const need = new Map<string, number>();
  for (const h of handles) need.set(h, (need.get(h) ?? 0) + 1);
  return need;
};

export function allocateStock(
  onHand: Map<string, number>,
  orders: AllocOrder[],
): AllocResult {
  const free = new Map<string, number>();
  for (const [h, n] of onHand) free.set(h, Math.max(0, n));
  const take = (h: string, n: number) => free.set(h, (free.get(h) ?? 0) - n);

  for (const o of orders) {
    if (o.status !== 'ready_to_ship') continue;
    for (const [h, n] of countUnits(o.handles)) take(h, n);
  }

  const open = orders
    .filter((o) => OPEN.has(o.status))
    .sort(
      (a, b) =>
        a.created_at.getTime() - b.created_at.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  const result: AllocResult = { ready: [], short: [] };
  for (const o of open) {
    const need = countUnits(o.handles);
    let covered = true;
    for (const [h, n] of need) {
      const got = Math.min(n, Math.max(0, free.get(h) ?? 0));
      if (got < n) covered = false;
      take(h, got);
    }
    (covered ? result.ready : result.short).push(o.id);
  }
  return result;
}
