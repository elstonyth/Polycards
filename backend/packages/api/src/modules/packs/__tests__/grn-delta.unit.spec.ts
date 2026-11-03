import { grnQtyDelta } from '../grn-delta';

const line = (id: string, card_handle: string, qty: number) => ({
  id,
  card_handle,
  qty,
});

describe('grnQtyDelta', () => {
  it('moves each card by the difference only', () => {
    expect(
      grnQtyDelta(
        [line('old-a', 'a', 3), line('old-b', 'b', 1)],
        [line('new-a', 'a', 2), line('new-b', 'b', 4)],
      ),
    ).toEqual([
      { card_handle: 'a', qty: -1, ref_id: 'new-a' },
      { card_handle: 'b', qty: 3, ref_id: 'new-b' },
    ]);
  });

  it('leaves out a card whose total did not change, even split across lines', () => {
    expect(
      grnQtyDelta(
        [line('old-a', 'a', 3)],
        [line('new-a1', 'a', 1), line('new-a2', 'a', 2)],
      ),
    ).toEqual([]);
  });

  it('takes a removed card off in full and points at its old line', () => {
    expect(
      grnQtyDelta([line('old-a', 'a', 2)], [line('new-c', 'c', 5)]),
    ).toEqual([
      { card_handle: 'a', qty: -2, ref_id: 'old-a' },
      { card_handle: 'c', qty: 5, ref_id: 'new-c' },
    ]);
  });
});
