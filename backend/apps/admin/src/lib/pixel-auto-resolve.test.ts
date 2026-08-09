import { describe, expect, it } from 'vitest';
import { matchSeededEntry } from './pixel-auto-resolve';
import type { PixelPokemonRow } from './admin-rest';

const row = (over: Partial<PixelPokemonRow>): PixelPokemonRow => ({
  id: 'id',
  name: 'Pikachu',
  dex: 25,
  variant: 'normal',
  types: [],
  image_url: null,
  is_custom: false,
  ...over,
});

describe('matchSeededEntry', () => {
  it('resolves a suffixed PC name to the seeded normal-variant row', () => {
    const pikachu = row({ id: 'pk-normal' });
    const custom = row({ id: 'pk-custom', variant: 'custom', is_custom: true });
    expect(
      matchSeededEntry('Pikachu with Grey Felt Hat #85', [custom, pikachu]),
    ).toBe(pikachu);
  });

  it('matches by dex, not by row name', () => {
    // The fetch is q=<species name>; a custom row named "Pikachu Party" for a
    // different dex must not win.
    const other = row({ id: 'other', name: 'Pikachu Party', dex: 999 });
    const pikachu = row({ id: 'pk-normal' });
    expect(matchSeededEntry('Pikachu ex #238', [other, pikachu])).toBe(pikachu);
  });

  it('returns null for trainer/energy cards with no species in the name', () => {
    expect(matchSeededEntry("Professor's Research #189", [row({})])).toBeNull();
  });

  it('returns null when the seeded row is absent from the page', () => {
    expect(matchSeededEntry('Pikachu VMAX', [])).toBeNull();
  });
});
