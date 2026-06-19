import {
  pokemonFromCard,
  POKEDEX_NAMES,
  spriteGif,
  spritePng,
} from '../index';

describe('@acme/pokemon', () => {
  describe('POKEDEX_NAMES', () => {
    it('is 1-based national dex (Bulbasaur = dex 1)', () => {
      expect(POKEDEX_NAMES[0]).toBe('Bulbasaur');
      expect(POKEDEX_NAMES.length).toBeGreaterThanOrEqual(1025);
    });
  });

  describe('pokemonFromCard', () => {
    it('matches a full species name in the card name', () => {
      expect(pokemonFromCard('Charizard VMAX')).toEqual({
        dex: 6,
        name: 'Charizard',
      });
    });

    it('prefers the longest match (Mewtwo over Mew)', () => {
      expect(pokemonFromCard('Mewtwo GX')?.name).toBe('Mewtwo');
    });

    it('returns null when no species is present', () => {
      expect(pokemonFromCard("Professor's Research")).toBeNull();
    });
  });

  describe('sprite URL helpers', () => {
    it('spriteGif points at the PokeAPI showdown gif for the dex', () => {
      expect(spriteGif(6)).toBe(
        'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/other/showdown/6.gif',
      );
    });
    it('spritePng points at the PokeAPI static png for the dex', () => {
      expect(spritePng(6)).toBe(
        'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/6.png',
      );
    });
  });
});
