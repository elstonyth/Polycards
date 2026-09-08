import { describe, it, expect } from 'vitest';
import { resolveCardPokemon } from '@/lib/resolve-card-pokemon';
import { POKEDEX_NAMES } from '@/lib/mock/pokedex-names';

describe('resolveCardPokemon', () => {
  it.each([994, 995])(
    'avoids an unavailable Showdown animation for dex %i',
    (dex) => {
      expect(
        resolveCardPokemon({ name: 'Card', pokemon_dex: dex }).sprite,
      ).toBe(
        `https://cdn.jsdelivr.net/gh/PokeAPI/sprites@master/sprites/pokemon/${dex}.png`,
      );
    },
  );

  it('explicit pokemon_dex wins over name-derivation', () => {
    const r = resolveCardPokemon({ name: 'Pikachu Card', pokemon_dex: 150 });
    expect(r.dex).toBe(150);
    expect(r.name).toBe('Mewtwo');
  });

  it('custom sprite_image wins over the dex gif', () => {
    const r = resolveCardPokemon({
      name: 'Charizard',
      pokemon_dex: 6,
      sprite_image: '/static/custom.png',
    });
    expect(r.sprite).toBe('/static/custom.png');
  });

  it('falls back to name-derivation when pokemon_dex is null', () => {
    const r = resolveCardPokemon({ name: 'Charizard VMAX', pokemon_dex: null });
    expect(r.dex).toBe(6);
    expect(r.name).toBe('Charizard');
    expect(r.sprite).toContain('/6.gif');
  });

  it('treats an out-of-range dex as unset and falls through to the name', () => {
    const r = resolveCardPokemon({ name: 'Charizard', pokemon_dex: 99999 });
    expect(r.dex).toBe(6); // from the name, not the bad dex
    const r2 = resolveCardPokemon({
      name: "Professor's Research",
      pokemon_dex: 0,
    });
    expect(r2.dex).toBeNull();
  });

  it('resolves to all-null for an unresolvable card with no fields', () => {
    const r = resolveCardPokemon({ name: "Professor's Research" });
    expect(r).toEqual({ dex: null, name: null, sprite: null });
  });

  it('uses the full national dex range', () => {
    expect(POKEDEX_NAMES.length).toBeGreaterThanOrEqual(1025);
  });
});
