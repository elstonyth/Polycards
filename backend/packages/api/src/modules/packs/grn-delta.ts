type GrnLine = { id: string; card_handle: string; qty: number };

// What an edit of a goods receive note changes per card: the new total qty
// minus the old one, cards whose total is unchanged left out. It drives the
// edit's stock movements and the Medusa counter, so both move by the
// difference only. ref_id is the card's new line, or its old line when the
// edit took the card off the note.
export function grnQtyDelta(
  before: GrnLine[],
  after: GrnLine[],
): { card_handle: string; qty: number; ref_id: string }[] {
  const net = new Map<string, { qty: number; ref_id: string }>();
  const add = (l: GrnLine, sign: 1 | -1) => {
    const seen = net.get(l.card_handle);
    net.set(l.card_handle, {
      qty: (seen?.qty ?? 0) + sign * Number(l.qty),
      ref_id: sign === 1 ? l.id : (seen?.ref_id ?? l.id),
    });
  };
  for (const l of before) add(l, -1);
  for (const l of after) add(l, 1);
  return [...net]
    .filter(([, d]) => d.qty !== 0)
    .map(([card_handle, d]) => ({ card_handle, ...d }));
}
