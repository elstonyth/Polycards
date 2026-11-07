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

/** Units each open or ready_to_ship order holds, by order id then card. */
export type AllocHeld = Map<string, Map<string, number>>;

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
  const { ready, short } = allocateUnits(onHand, orders);
  return { ready, short };
}

// The same run, also saying which units each order holds — what the Orders
// page shows as "in stock" / "missing" per card (operator, 2026-11-07).
export function allocateUnits(
  onHand: Map<string, number>,
  orders: AllocOrder[],
): AllocResult & { held: AllocHeld } {
  const free = new Map<string, number>();
  for (const [h, n] of onHand) free.set(h, Math.max(0, n));
  const take = (h: string, n: number) => free.set(h, (free.get(h) ?? 0) - n);
  const held: AllocHeld = new Map();

  for (const o of orders) {
    if (o.status !== 'ready_to_ship') continue;
    const need = countUnits(o.handles);
    for (const [h, n] of need) take(h, n);
    held.set(o.id, need);
  }

  const open = orders
    .filter((o) => OPEN.has(o.status))
    .sort(
      (a, b) =>
        a.created_at.getTime() - b.created_at.getTime() ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );

  const result: AllocResult & { held: AllocHeld } = {
    ready: [],
    short: [],
    held,
  };
  for (const o of open) {
    const need = countUnits(o.handles);
    const got = new Map<string, number>();
    let covered = true;
    for (const [h, n] of need) {
      const g = Math.min(n, Math.max(0, free.get(h) ?? 0));
      if (g < n) covered = false;
      take(h, g);
      got.set(h, g);
    }
    held.set(o.id, got);
    (covered ? result.ready : result.short).push(o.id);
  }
  return result;
}

export type CardCover = {
  handle: string;
  /** Units of this card the order wants. */
  need: number;
  /** Of those, how many the stock covers for this order (oldest first). */
  have: number;
  /** On hand for the card overall, never below 0 — more than `have` means
   *  the rest is kept for other orders. */
  on_hand: number;
};

/** Per card of one order, first-seen order; null when the order is not
 *  waiting on or holding stock (shipped, completed, canceled, unknown). */
export function stockCoverFor(
  orderId: string,
  onHand: Map<string, number>,
  orders: AllocOrder[],
): CardCover[] | null {
  const order = orders.find((o) => o.id === orderId);
  if (!order || !(OPEN.has(order.status) || order.status === 'ready_to_ship'))
    return null;
  const held = allocateUnits(onHand, orders).held.get(orderId);
  return [...countUnits(order.handles)].map(([handle, need]) => ({
    handle,
    need,
    have: held?.get(handle) ?? 0,
    on_hand: Math.max(0, onHand.get(handle) ?? 0),
  }));
}
