import { mirroredCardFields } from '../card-pixel-pokemon';

describe('mirroredCardFields', () => {
  test('mirrors a linked entry onto the card render columns', () => {
    expect(
      mirroredCardFields({ dex: 745, image_url: 'https://cdn/pixel-745.gif' }),
    ).toEqual({ pokemon_dex: 745, sprite_image: 'https://cdn/pixel-745.gif' });
  });

  test('a spriteless / dexless entry mirrors to nulls (→ poké-ball fallback)', () => {
    expect(mirroredCardFields({ dex: null, image_url: null })).toEqual({
      pokemon_dex: null,
      sprite_image: null,
    });
  });
});
