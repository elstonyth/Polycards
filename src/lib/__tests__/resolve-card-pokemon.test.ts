import { describe, it, expect } from 'vitest';
import { isPokemonPack, resolveCardPokemon } from '@/lib/resolve-card-pokemon';
import { POKEDEX_NAMES } from '@/lib/mock/pokedex-names';
import { STATIC_ONLY_DEX } from '@/lib/mock/pokedex';

describe('resolveCardPokemon', () => {
  it.each([...STATIC_ONLY_DEX])(
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

  it('does not mine a dex-less custom sprite card name for a species', () => {
    // "Bartholomew Kuma" contains "mew": a One Piece card linked to its own
    // sprite must stay dex-less, or the reel flickers Mew for it.
    const r = resolveCardPokemon({
      name: 'Bartholomew Kuma OP07-079',
      pokemon_dex: null,
      sprite_image: 'https://cdn.example/kuma.gif',
    });
    expect(r).toEqual({
      dex: null,
      name: null,
      sprite: 'https://cdn.example/kuma.gif',
    });
    // Same name with nothing configured still derives (legacy unlinked cards).
    expect(resolveCardPokemon({ name: 'Bartholomew Kuma' }).name).toBe('Mew');
  });

  it('a non-Pokémon pack never resolves a Pokémon — not even a stray dex', () => {
    expect(
      resolveCardPokemon(
        { name: 'Pikachu', pokemon_dex: 25, sprite_image: null },
        { pokemon: false },
      ),
    ).toEqual({ dex: null, name: null, sprite: null });
    // its own custom sprite still shows
    expect(
      resolveCardPokemon(
        {
          name: 'Bartholomew Kuma',
          sprite_image: 'https://cdn.example/kuma.gif',
        },
        { pokemon: false },
      ).sprite,
    ).toBe('https://cdn.example/kuma.gif');
  });

  it('isPokemonPack: only Pokémon packs resolve Pokémon — any other deck, even a new one, opts out', () => {
    for (const c of ['one-piece', 'basketball', 'yugioh', 'some-future-deck'])
      expect(isPokemonPack(c)).toBe(false);
    // free_welcome / reward_box carry Pokémon prizes
    for (const c of ['pokemon', 'free_welcome', 'reward_box', undefined])
      expect(isPokemonPack(c)).toBe(true);
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

describe('a One Piece card by its own set or code (#842 review)', () => {
  it('never resolves a Pokémon, with or without pack context', () => {
    const kuma = {
      name: 'Bartholomew Kuma',
      set: 'One Piece Wings of the Captain',
    };
    expect(resolveCardPokemon(kuma)).toEqual({
      dex: null,
      name: null,
      sprite: null,
    });
    // a reward box is a Pokémon-allowlisted pack, but Kuma is still not Mew
    expect(resolveCardPokemon(kuma, { pokemon: true }).dex).toBeNull();
    expect(
      resolveCardPokemon({ name: 'Bartholomew Kuma OP07-079' }).dex,
    ).toBeNull();
  });

  it('keeps a linked One Piece sprite', () => {
    expect(
      resolveCardPokemon({
        name: 'Monkey.D.Luffy OP05-119',
        sprite_image: '/sprites/gear5.gif',
      }).sprite,
    ).toBe('/sprites/gear5.gif');
  });

  it('leaves Pokémon cards alone', () => {
    expect(
      resolveCardPokemon({ name: 'Mew #151', set: 'Pokemon 151' }).dex,
    ).toBe(151);
  });
});
