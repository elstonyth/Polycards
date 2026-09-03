import { describe, expect, it } from 'vitest';
import { badgeSprite } from '@/lib/pokemon-badge-sprite';

describe('badgeSprite', () => {
  it('uses the CONFIGURED dex, not the name', () => {
    // The camelCase→snake_case mapping into resolveCardPokemon is the trap:
    // pass the wrong key and this silently falls to name derivation, the code
    // still compiles, and the admin's choice is lost with nothing to notice it.
    const { chain } = badgeSprite({ name: 'Zapdos Card', pokemonDex: 150 });
    expect(chain[0]).toContain('/150.gif');
    expect(chain[1]).toContain('/150.png');
  });

  it('leads with a custom sprite but KEEPS the dex fallbacks behind it', () => {
    const { chain } = badgeSprite({
      name: 'Pikachu',
      pokemonDex: 25,
      spriteImage: 'https://cdn.example/custom.gif',
    });
    expect(chain).toEqual([
      'https://cdn.example/custom.gif',
      expect.stringContaining('/25.gif'),
      expect.stringContaining('/25.png'),
    ]);
  });

  it('renders nothing for a card with no resolvable Pokémon', () => {
    expect(badgeSprite({ name: "Professor's Research" }).chain).toEqual([]);
  });

  it('falls back to name derivation when the dex is out of range', () => {
    const { chain, name } = badgeSprite({
      name: 'Charizard',
      pokemonDex: 99999,
    });
    expect(name).toBe('Charizard');
    expect(chain[0]).toContain('/6.gif');
  });

  it('drops the animated sprite under `still`', () => {
    const { chain } = badgeSprite({ name: 'Pikachu', pokemonDex: 25 }, true);
    expect(chain).toEqual([expect.stringContaining('/25.png')]);
    expect(chain.some((s) => s.endsWith('.gif'))).toBe(false);
  });

  it('treats a blank custom sprite as absent', () => {
    const { chain } = badgeSprite({
      name: 'Pikachu',
      pokemonDex: 25,
      spriteImage: '   ',
    });
    expect(chain[0]).toContain('/25.gif');
  });
});
