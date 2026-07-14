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
