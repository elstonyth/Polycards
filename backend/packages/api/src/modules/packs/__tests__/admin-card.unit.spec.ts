import { toAdminCardDto } from '../admin-card';

const card = {
  handle: 'pikachu-001',
  name: 'Pikachu',
  set: 'Base',
  grader: 'PSA',
  grade: '10',
  market_value: '0.15',
  image: '/p.png',
  slab_image: null as string | null,
  price: '1.50',
  for_sale: true,
  pixel_pokemon_id: null as string | null,
  pokemon_dex: null as number | null,
  sprite_image: null as string | null,
  pc_product_id: null as string | null,
  pc_grade: null as string | null,
  market_multiplier: '1.2',
  pc_synced_at: null as string | Date | null,
  label_year: null as string | null,
  label_note: null as string | null,
  created_at: new Date('2026-01-02T03:04:05.000Z') as Date | string,
};

describe('toAdminCardDto', () => {
  it('shapes the admin card DTO with money-normalized FMV, price, and pixel-pokemon fields', () => {
    expect(toAdminCardDto(card)).toEqual({
      handle: 'pikachu-001',
      name: 'Pikachu',
      set: 'Base',
      grader: 'PSA',
      grade: '10',
      market_value: 0.15,
      image: '/p.png',
      slab_image: null,
      price: 1.5,
      for_sale: true,
      pixel_pokemon_id: null,
      pokemon_dex: null,
      sprite_image: null,
      pc_product_id: null,
      pc_grade: null,
      market_multiplier: 1.2,
      pc_synced_at: null,
      label_year: null,
      label_note: null,
      // Passed straight through (no money/date coercion) — the admin cards
      // list sorts its "Added" column on it.
      created_at: new Date('2026-01-02T03:04:05.000Z'),
    });
  });

  it('preserves a null price sentinel (use-FMV) without coercing it to 0', () => {
    expect(toAdminCardDto({ ...card, price: null }).price).toBeNull();
  });

  // The admin list route appends `stock`; the detail route never returns it.
  // The seam must NOT emit `stock`, or the detail response gains a field it
  // never had (the behavior trap that kept this a base DTO + spread, not a
  // toAdminCardDto(card, stock?) with an optional param).
  it('does not emit a stock field', () => {
    expect(toAdminCardDto(card)).not.toHaveProperty('stock');
  });

  // Passing fxRate adds `priceBreakdown` (raw FMV, the fx rate used, the
  // no-markup MYR price, the card's own display price, and the markup
  // difference) — all rounded to cents by displayMarketPrice/toMoney.
  // Fixture: market_value 0.15, market_multiplier 1.2, fxRate 4.7 ->
  // marketMyr = round(0.15*4.7*1*100)/100 = 0.71
  // displayPrice = round(0.15*4.7*1.2*100)/100 = 0.85
  // markup = round((0.85-0.71)*100)/100 = 0.14
  it('adds a rounded priceBreakdown when an fxRate is passed', () => {
    const dto = toAdminCardDto(card, 4.7) as ReturnType<
      typeof toAdminCardDto
    > & {
      priceBreakdown: {
        raw: number;
        fxRate: number;
        marketMyr: number;
        displayPrice: number;
        markup: number;
      };
    };
    expect(dto.priceBreakdown).toEqual({
      raw: 0.15,
      fxRate: 4.7,
      marketMyr: 0.71,
      displayPrice: 0.85,
      markup: 0.14,
    });
  });
});
