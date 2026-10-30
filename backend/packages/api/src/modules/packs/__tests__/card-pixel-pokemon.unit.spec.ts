import { mirroredCardFields } from '../card-pixel-pokemon';

describe('mirroredCardFields', () => {
  test('mirrors a linked entry onto the card render columns', () => {
    expect(
      mirroredCardFields({ dex: 745, image_url: 'https://cdn/pixel-745.gif' }),
    ).toEqual({ pokemon_dex: 745, sprite_image: 'https://cdn/pixel-745.gif' });
  });

  test('a non-Pokémon entry never mirrors a dex, whatever the row holds', () => {
    // One Piece #25 must not render as Pikachu on the card.
    expect(
      mirroredCardFields({
        dex: 25,
        image_url: 'https://cdn/op-luffy.gif',
        franchise: 'one-piece',
      }),
    ).toEqual({ pokemon_dex: null, sprite_image: 'https://cdn/op-luffy.gif' });
    // a pre-franchise row (no field) is a Pokémon
    expect(
      mirroredCardFields({ dex: 25, image_url: null, franchise: undefined })
        .pokemon_dex,
    ).toBe(25);
  });

  test('a spriteless / dexless entry mirrors to nulls (→ poké-ball fallback)', () => {
    expect(mirroredCardFields({ dex: null, image_url: null })).toEqual({
      pokemon_dex: null,
      sprite_image: null,
    });
  });
});
