// Shift-click range selection (the Gmail convention), pure so it is testable
// in node: a plain click toggles the clicked id; a shift-click applies the
// clicked id's NEW state to every id between the anchor (the previously
// clicked id) and it, in the order of `ids` (the list as currently sorted).
// Falls back to a plain toggle when there is no usable anchor — no prior
// click, anchor === clicked, or the anchor has left the list (search/sort
// changed underneath).
export function applyRangeSelect(
  prev: ReadonlySet<string>,
  ids: readonly string[],
  anchor: string | null,
  clicked: string,
  shiftKey: boolean,
): Set<string> {
  const next = new Set(prev);
  if (shiftKey && anchor !== null && anchor !== clicked) {
    const a = ids.indexOf(anchor);
    const b = ids.indexOf(clicked);
    if (a !== -1 && b !== -1) {
      // The clicked checkbox's resulting state drives the whole range:
      // shift-click on an unchecked box checks the block, on a checked box
      // unchecks it — so strays can be swept out the same way they got in.
      const check = !prev.has(clicked);
      for (const id of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) {
        if (check) next.add(id);
        else next.delete(id);
      }
      return next;
    }
  }
  if (!next.delete(clicked)) next.add(clicked);
  return next;
}
