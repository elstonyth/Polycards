import type {
  AdminDeliveryItem,
  DeliveryOrderCardCover,
} from '../../lib/admin-rest';

export type ItemCover = {
  inStock: boolean;
  /** Missing, but the card is on the shelf: other orders hold those units. */
  keptForOthers: boolean;
};

// Marks each item of the Manage modal in stock or missing from the server's
// per-card split. A card wanted twice with one unit covered shows its first
// copy in stock and the second missing. An item whose card row is gone has no
// handle to match, so it gets no mark rather than a wrong one.
export function coverItems(
  items: AdminDeliveryItem[],
  cards: DeliveryOrderCardCover[],
): { byPull: Map<string, ItemCover>; inStock: number; missing: number } {
  const byHandle = new Map(cards.map((c) => [c.handle, c]));
  const left = new Map(cards.map((c) => [c.handle, c.have]));
  const byPull = new Map<string, ItemCover>();
  let inStock = 0;
  let missing = 0;
  for (const it of items) {
    const card = it.card ? byHandle.get(it.card.handle) : undefined;
    if (!card) continue;
    const n = left.get(card.handle) ?? 0;
    if (n > 0) {
      left.set(card.handle, n - 1);
      byPull.set(it.pull_id, { inStock: true, keptForOthers: false });
      inStock++;
    } else {
      byPull.set(it.pull_id, {
        inStock: false,
        keptForOthers: card.on_hand > card.have,
      });
      missing++;
    }
  }
  return { byPull, inStock, missing };
}
