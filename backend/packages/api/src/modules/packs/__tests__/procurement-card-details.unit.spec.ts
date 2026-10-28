import { addCardDetails, type ToBuyRow } from '../procurement-view';

// Owner 2026-10-29: the to-buy list carries the picture staff look for and
// the raw PriceCharting price, so a screenshot of it works in the buyers'
// group chat.
const row = (over: Partial<ToBuyRow> = {}): ToBuyRow => ({
  handle: 'card-a',
  name: 'Card A',
  sku: 'CARD-A',
  photo: 'https://cdn/product-thumb.webp',
  graded: false,
  to_procure: 1,
  on_hand: 0,
  requested: 1,
  ready_to_ship: 0,
  fmv: 99,
  oldest_order_at: null,
  ...over,
});
const card = (over: Record<string, unknown> = {}) => ({
  handle: 'card-a',
  image: 'https://cdn/card.webp',
  slab_image: null as string | null,
  market_value: '10.00',
  ...over,
});
const byHandle = (...cards: ReturnType<typeof card>[]) =>
  new Map(cards.map((c) => [c.handle, c]));

describe('addCardDetails', () => {
  it('graded: shows the baked slab', () => {
    const [r] = addCardDetails(
      [row({ graded: true })],
      byHandle(card({ slab_image: 'https://cdn/slab.webp' })),
      4.5,
    );
    expect(r.image).toBe('https://cdn/slab.webp');
  });

  it('graded but not baked yet: falls back to the card picture', () => {
    const [r] = addCardDetails(
      [row({ graded: true })],
      byHandle(card({ slab_image: '' })),
      4.5,
    );
    expect(r.image).toBe('https://cdn/card.webp');
  });

  it('raw: shows the bare card, never a slab', () => {
    const [r] = addCardDetails(
      [row({ graded: false })],
      byHandle(card({ slab_image: 'https://cdn/slab.webp' })),
      4.5,
    );
    expect(r.image).toBe('https://cdn/card.webp');
  });

  it('PriceCharting price as is: USD plus RM at the live rate, no 20% markup', () => {
    const [r] = addCardDetails(
      [row()],
      byHandle(card({ market_value: '12.34' })),
      4.5,
    );
    expect(r.fmv_usd).toBe(12.34);
    expect(r.fmv).toBe(55.53); // 12.34 × 4.5, not × 1.2
  });

  it('no card row: keeps the product photo and stored RM, no USD', () => {
    const [r] = addCardDetails([row()], new Map(), 4.5);
    expect(r.image).toBe('https://cdn/product-thumb.webp');
    expect(r.fmv_usd).toBeNull();
    expect(r.fmv).toBe(99);
  });

  it('a row frozen before this change (no image field) still gets one', () => {
    const frozen = { ...row() } as Partial<ToBuyRow>;
    delete frozen.photo;
    const [r] = addCardDetails([frozen as ToBuyRow], new Map(), 4.5);
    expect(r.image).toBeNull();
  });
});
