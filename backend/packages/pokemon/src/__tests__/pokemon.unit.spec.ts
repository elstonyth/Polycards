import {
  pokemonFromCard,
  allPokemonMatches,
  POKEDEX_NAMES,
  spriteGif,
  spritePng,
  STATIC_ONLY_DEX,
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
    it('spriteGif points at the jsDelivr showdown gif for the dex', () => {
      expect(spriteGif(6)).toBe(
        'https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/other/showdown/6.gif',
      );
    });
    it('spritePng points at the jsDelivr static png for the dex', () => {
      expect(spritePng(6)).toBe(
        'https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/6.png',
      );
    });
    // Same set as the storefront copy (src/lib/mock/pokedex.ts): the admin
    // picker renders these with no error fallback, so a 404 GIF stays broken.
    it.each([...STATIC_ONLY_DEX])(
      'spriteGif serves the static png for GIF-less dex %i',
      (dex) => {
        expect(spriteGif(dex)).toBe(spritePng(dex));
      },
    );
    it('keeps the storefront set: the dex that 404d on the prod reel', () => {
      expect(STATIC_ONLY_DEX.has(1017)).toBe(true);
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
