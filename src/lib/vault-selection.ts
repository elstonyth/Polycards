// Select-All semantics for the vault grid (spec §3): acts on the VISIBLE
// cards only (rarity filter + search applied), never touching hidden
// selections — cross-filter selections persist. Ticked ⇔ all visible
// selected; toggling then deselects the visible ids only.
export function toggleSelectAll(
  selected: ReadonlySet<string>,
  visibleIds: readonly string[],
): Set<string> {
  const next = new Set(selected);
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => next.has(id));
  if (allVisibleSelected) {
    for (const id of visibleIds) next.delete(id);
  } else {
    for (const id of visibleIds) next.add(id);
  }
  return next;
}

/** What a sell-back of `items` pays and how much of it is held for packs —
 *  the per-item quotes summed. `held` is only each quote's own `bonus` (the
 *  bonus-paid share, or the welcome card); gift and reward cards quote 0. */
export function sellTotals(
  items: readonly { buyback: { amount: number; bonus: number } }[],
): { amount: number; held: number } {
  let amount = 0;
  let held = 0;
  for (const i of items) {
    amount += i.buyback.amount;
    held += i.buyback.bonus;
  }
  return { amount, held };
}
