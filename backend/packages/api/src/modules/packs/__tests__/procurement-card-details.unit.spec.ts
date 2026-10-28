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
  grader: '',
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
      byHandle(card({ grader: 'PSA', slab_image: 'https://cdn/slab.webp' })),
      4.5,
    );
    expect(r.image).toBe('https://cdn/slab.webp');
  });

  it.each([null, ''])(
    'graded but not baked (slab_image %p): falls back to the card picture',
    (slab) => {
      const [r] = addCardDetails(
        [row({ graded: true })],
        byHandle(card({ grader: 'PSA', slab_image: slab })),
        4.5,
      );
      expect(r.image).toBe('https://cdn/card.webp');
    },
  );

  it('card picture empty: falls back to the product photo', () => {
    const [r] = addCardDetails([row()], byHandle(card({ image: '' })), 4.5);
    expect(r.image).toBe('https://cdn/product-thumb.webp');
  });

  it('PriceCharting price 0 shows as 0, not as missing', () => {
    const [r] = addCardDetails(
      [row()],
      byHandle(card({ market_value: 0 })),
      4.5,
    );
    expect(r.fmv_usd).toBe(0);
    expect(r.fmv).toBe(0);
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

  it('a row read back from a 12am snapshot gets the picture and today’s price', () => {
    const frozen = JSON.parse(
      JSON.stringify(row({ graded: true, fmv: 50 })),
    ) as ToBuyRow;
    const [r] = addCardDetails(
      [frozen],
      byHandle(card({ grader: 'PSA', slab_image: null, market_value: '20' })),
      4.5,
    );
    expect(r.image).toBe('https://cdn/card.webp');
    expect(r.fmv_usd).toBe(20);
    expect(r.fmv).toBe(90);
  });

  it('GRADED/RAW follows the card today, not the frozen row: label and picture agree', () => {
    const [nowGraded] = addCardDetails(
      [row({ graded: false })],
      byHandle(card({ grader: 'PSA', slab_image: 'https://cdn/slab.webp' })),
      4.5,
    );
    expect([nowGraded.graded, nowGraded.image]).toEqual([
      true,
      'https://cdn/slab.webp',
    ]);
    const [noCard] = addCardDetails([row({ graded: true })], new Map(), 4.5);
    expect(noCard.graded).toBe(true);
  });

  it('no card and no photo: image is null, not undefined', () => {
    const [r] = addCardDetails([row({ photo: null })], new Map(), 4.5);
    expect(r.image).toBeNull();
  });
});
