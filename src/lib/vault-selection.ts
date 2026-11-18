// The vault grid's selection: which cards can be picked, what Select All does,
// and what the picked cards are worth. It owns one rule the grid must never
// repeat inline: a LOCKED card (the free welcome pull before the first PAID
// open) is never selectable — the backend refuses to sell or ship it. Keyed on
// `locked` ONLY: a weekly-challenge prize is source='reward' with a live,
// sellable quote and must stay selectable.

type Selectable = { pullId: string; locked: boolean };

type Priced = Selectable & {
  sellable: boolean;
  card: { priceMyr: number | null };
  buyback: { amount: number; bonus: number };
};

export type SelectOp =
  | { type: 'toggle'; pullId: string }
  /** Select All over the cards passed in. */
  | { type: 'toggleAll' };

const selectableIds = (items: readonly Selectable[]) =>
  items.filter((i) => !i.locked).map((i) => i.pullId);

/** The next selection, given the VISIBLE cards (rarity filter + search
 *  applied). A toggle on a locked card returns `selected` itself, so React
 *  skips the render; every other op returns a fresh Set. */
export function select(
  selected: ReadonlySet<string>,
  visible: readonly Selectable[],
  op: SelectOp,
): ReadonlySet<string> {
  if (op.type === 'toggle') {
    if (visible.some((i) => i.pullId === op.pullId && i.locked))
      return selected;
    const next = new Set(selected);
    if (next.has(op.pullId)) next.delete(op.pullId);
    else next.add(op.pullId);
    return next;
  }
  // Spec §3: acts on the visible cards only, never touching hidden selections
  // — cross-filter selections persist. All visible selected ⇒ deselect them.
  const ids = selectableIds(visible);
  const deselect = selectAllState(selected, visible).allSelected;
  const next = new Set(selected);
  for (const id of ids) {
    if (deselect) next.delete(id);
    else next.add(id);
  }
  return next;
}

/** What the Select All control shows: how many visible cards it acts on, and
 *  whether it is ticked (they are all selected). */
export function selectAllState(
  selected: ReadonlySet<string>,
  visible: readonly Selectable[],
): { count: number; allSelected: boolean } {
  const ids = selectableIds(visible);
  return {
    count: ids.length,
    allSelected: ids.length > 0 && ids.every((id) => selected.has(id)),
  };
}

/**
 * The selected cards and what they are worth. Money sums read the MYR price;
 * an unpriced card (null — an older backend) counts as 0 so totals stay
 * numbers. The sell math runs over the backend's `sellable` subset, never the
 * selection itself, so the total only includes cards the buyback step will
 * honour. `amount` is the per-item quotes summed; `held` is only each quote's
 * own `bonus` (the bonus-paid share, or the welcome card) — the part for packs.
 */
export function selectionSummary<T extends Priced>(
  selected: ReadonlySet<string>,
  items: readonly T[],
): {
  items: T[];
  sellable: T[];
  fmv: number;
  sellableFmv: number;
  amount: number;
  held: number;
} {
  const picked = items.filter((i) => selected.has(i.pullId) && !i.locked);
  const sellable = picked.filter((i) => i.sellable);
  const fmvOf = (list: readonly T[]) =>
    list.reduce((s, i) => s + (i.card.priceMyr ?? 0), 0);
  let amount = 0;
  let held = 0;
  for (const i of sellable) {
    amount += i.buyback.amount;
    held += i.buyback.bonus;
  }
  return {
    items: picked,
    sellable,
    fmv: fmvOf(picked),
    sellableFmv: fmvOf(sellable),
    amount,
    held,
  };
}
