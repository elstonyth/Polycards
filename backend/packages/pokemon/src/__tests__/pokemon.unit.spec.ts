import {
  pokemonFromCard,
  allPokemonMatches,
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

  describe('allPokemonMatches', () => {
    test('flags the Rockruff/Lycanroc evolution collision (both 744 and 745)', () => {
      const m = allPokemonMatches(
        '2016 Pokemon Japanese Sun & Moon Rockruff Full Power Deck Holo Lycanroc GX #9 CGC 5.5',
      );
      expect(m.map((x) => x.dex).sort((a, b) => a - b)).toEqual([744, 745]);
    });

    test('does not double-count a contained name (Mewtwo, not Mew)', () => {
      const m = allPokemonMatches(
        '2025 Pokemon Japanese SV Glory Of Rocket Gang Holo Team Rockets Mewtwo ex CGC 10',
      );
      expect(m.map((x) => x.dex)).toEqual([150]);
    });

    test('a single clean species is unambiguous', () => {
      const m = allPokemonMatches(
        '2023 Pokemon Japanese Scarlet & Violet 151 Holo Gengar #94 CGC 10 GEM MINT',
      );
      expect(m.map((x) => x.name)).toEqual(['Gengar']);
    });
  });
});
