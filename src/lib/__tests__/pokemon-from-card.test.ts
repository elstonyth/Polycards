// src/lib/__tests__/pokemon-from-card.test.ts
import { describe, it, expect } from 'vitest';
import { pokemonFromCard } from '../pokemon-from-card';

describe('pokemonFromCard', () => {
  it('finds the base Pokémon in a real card name', () => {
    expect(
      pokemonFromCard('2021 Scarlet & Violet 151 Charizard ex PSA 10'),
    ).toEqual({
      dex: 6,
      name: 'Charizard',
    });
    expect(pokemonFromCard('2022 Crown Zenith Pikachu VMAX CGC 10')).toEqual({
      dex: 25,
      name: 'Pikachu',
    });
  });

  it('prefers the longest match (Mewtwo over Mew)', () => {
    expect(pokemonFromCard('Mewtwo ex')).toEqual({ dex: 150, name: 'Mewtwo' });
    expect(pokemonFromCard('Mew ex')).toEqual({ dex: 151, name: 'Mew' });
  });

  it('normalizes punctuation on both sides (hyphen, apostrophe, dot, colon)', () => {
    expect(pokemonFromCard('Ho-Oh V')).toEqual({ dex: 250, name: 'Ho Oh' });
    expect(pokemonFromCard("Farfetch'd")).toEqual({
      dex: 83,
      name: 'Farfetchd',
    });
    expect(pokemonFromCard('Mr. Mime')).toEqual({ dex: 122, name: 'Mr Mime' });
    expect(pokemonFromCard('Type: Null')).toEqual({
      dex: 772,
      name: 'Type Null',
    });
  });

  it('returns null for non-Pokémon cards and empty input', () => {
    expect(pokemonFromCard("Professor's Research")).toBeNull();
    expect(pokemonFromCard('')).toBeNull();
    expect(pokemonFromCard('   ')).toBeNull();
  });

  it('resolves form-labeled species when the card omits the form word', () => {
    // Dex entry is "Shaymin Land" — a bare "Shaymin VSTAR" card must still resolve.
    expect(
      pokemonFromCard(
        '2022 Pokemon Japanese Sword & Shield Star Birth Holo Shaymin VSTAR #13 CGC 9.5',
      ),
    ).toEqual({ dex: 492, name: 'Shaymin Land' });
    expect(pokemonFromCard('Deoxys EX')).toEqual({
      dex: 386,
      name: 'Deoxys Normal',
    });
    expect(pokemonFromCard('Giratina V')).toEqual({
      dex: 487,
      name: 'Giratina Altered',
    });
  });

  it('does not let the base fallback mis-resolve multi-word species', () => {
    // Full-name match wins — and the non-species first words are never base-indexed.
    expect(pokemonFromCard('Iron Hands ex')?.name).toBe('Iron Hands');
    expect(pokemonFromCard('Great Tusk ex')?.name).toBe('Great Tusk');
    expect(pokemonFromCard('Flutter Mane ex')?.name).toBe('Flutter Mane');
  });
});
