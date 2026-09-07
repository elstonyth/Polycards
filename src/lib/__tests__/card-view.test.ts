import { describe, it, expect } from 'vitest';
import { CardWireSchema, toCardView, type CardView } from '@/lib/card-view';

// The ONE card mapper. Nine seams used to hand-map the wire card and disagreed
// on the price default (`?? 0` in the vault and the reel, `?? null` elsewhere);
// these pin the contract every view now inherits: the exact field set (Task 7's
// SlabImage prop is typed off it), each default, the rarity guard, and the
// money invariant — `priceMyr` is null when unpriced, never 0.

const FULL = {
  handle: 'charizard-psa-10',
  name: 'Charizard PSA 10',
  image: '/charizard.webp',
  slab_image: '/charizard-slab.webp',
  rarity: 'Legendary',
  marketPriceMyr: 1234.5,
  pokemon_dex: 6,
  sprite_image: '/sprites/6.png',
};

describe('toCardView — shape', () => {
  it('maps every wire field to its camelCase view field, and nothing else', () => {
    // A real row carries more than the view reads (odds weight, pull fields).
    const row = { ...FULL, weight: 3, extra: 'x' };
    const view: CardView = toCardView(row);
    expect(view).toEqual({
      handle: 'charizard-psa-10',
      name: 'Charizard PSA 10',
      image: '/charizard.webp',
      slabImage: '/charizard-slab.webp',
      rarity: 'Legendary',
      priceMyr: 1234.5,
      pokemonDex: 6,
      spriteImage: '/sprites/6.png',
    });
  });

  it('defaults every field for an empty object (an older backend, a bare row)', () => {
    expect(toCardView({})).toEqual({
      handle: '',
      name: '',
      image: '',
      slabImage: null,
      rarity: null,
      priceMyr: null,
      pokemonDex: null,
      spriteImage: null,
    });
  });

  it('degrades a malformed field to its default instead of failing the card', () => {
    const view = toCardView({
      handle: 42,
      name: null,
      image: ['x'],
      slab_image: 7,
      sprite_image: false,
    });
    expect(view.handle).toBe('');
    expect(view.name).toBe('');
    expect(view.image).toBe('');
    expect(view.slabImage).toBeNull();
    expect(view.spriteImage).toBeNull();
  });

  it('keeps an explicit null slab_image / sprite_image as null', () => {
    const view = toCardView({ ...FULL, slab_image: null, sprite_image: null });
    expect(view.slabImage).toBeNull();
    expect(view.spriteImage).toBeNull();
  });
});

describe('toCardView — rarity guard', () => {
  it('passes a known tier through', () => {
    expect(toCardView({ rarity: 'Immortal' }).rarity).toBe('Immortal');
    expect(toCardView({ rarity: 'Common' }).rarity).toBe('Common');
  });

  it('nulls an unknown tier — a wrong-tier frame is worse than none', () => {
    expect(toCardView({ rarity: 'UltraRare' }).rarity).toBeNull();
    expect(toCardView({ rarity: 'rare' }).rarity).toBeNull(); // case matters
    expect(toCardView({ rarity: 5 }).rarity).toBeNull();
    expect(toCardView({ rarity: null }).rarity).toBeNull();
  });
});

describe('toCardView — priceMyr is null when unpriced, never 0', () => {
  it('is null when marketPriceMyr is absent (an un-enriched backend)', () => {
    expect(toCardView(FULL).priceMyr).toBe(1234.5);
    expect(toCardView({ ...FULL, marketPriceMyr: undefined }).priceMyr).toBe(
      null,
    );
  });

  it('is null for a non-finite or non-numeric price', () => {
    expect(toCardView({ marketPriceMyr: NaN }).priceMyr).toBeNull();
    expect(toCardView({ marketPriceMyr: Infinity }).priceMyr).toBeNull();
    expect(toCardView({ marketPriceMyr: '12.50' }).priceMyr).toBeNull();
  });

  it('keeps a genuine RM 0.00 as 0 — that is a price, not "unpriced"', () => {
    expect(toCardView({ marketPriceMyr: 0 }).priceMyr).toBe(0);
  });

  it('never reads the raw USD market_value as the MYR price', () => {
    // The raw FMV must never render behind an "RM" prefix.
    const usdOnly = { handle: 'h', market_value: 99 };
    expect(toCardView(usdOnly).priceMyr).toBeNull();
  });
});

describe('toCardView — pokemonDex', () => {
  it('accepts a positive integer dex and nulls anything else', () => {
    expect(toCardView({ pokemon_dex: 25 }).pokemonDex).toBe(25);
    expect(toCardView({ pokemon_dex: 0 }).pokemonDex).toBeNull();
    expect(toCardView({ pokemon_dex: -1 }).pokemonDex).toBeNull();
    expect(toCardView({ pokemon_dex: 2.5 }).pokemonDex).toBeNull();
    expect(toCardView({ pokemon_dex: '25' }).pokemonDex).toBeNull();
  });
});

describe('CardWireSchema', () => {
  it('is the same defaults, as a schema, for seams that embed it', () => {
    expect(CardWireSchema.parse({})).toEqual({
      handle: '',
      name: '',
      image: '',
      slab_image: null,
      rarity: null,
      marketPriceMyr: null,
      pokemon_dex: null,
      sprite_image: null,
    });
  });
});
