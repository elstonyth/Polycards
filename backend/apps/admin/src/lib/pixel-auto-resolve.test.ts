import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  fetchSeededCandidates,
  matchSeededEntry,
} from './pixel-auto-resolve';
import { getPixelPokemon, type PixelPokemonRow } from './admin-rest';

vi.mock('./admin-rest', () => ({ getPixelPokemon: vi.fn() }));

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

describe('fetchSeededCandidates', () => {
  it('dedupes identical species lookups and filters to seeded rows', async () => {
    const rows = [row({})];
    (getPixelPokemon as Mock).mockResolvedValue({ pixel_pokemon: rows });
    const [a, b] = await Promise.all([
      fetchSeededCandidates('Pikachu'),
      fetchSeededCandidates('Pikachu'),
    ]);
    expect(a).toBe(b); // same memoized promise, not two requests
    expect(getPixelPokemon).toHaveBeenCalledTimes(1);
    expect(getPixelPokemon).toHaveBeenCalledWith({
      q: 'Pikachu',
      variant: 'normal',
      custom: 'false',
    });
  });

  it('drops a failed lookup from the memo so a later mount retries', async () => {
    (getPixelPokemon as Mock).mockRejectedValueOnce(new Error('net down'));
    await expect(fetchSeededCandidates('Eevee')).rejects.toThrow('net down');
    (getPixelPokemon as Mock).mockResolvedValueOnce({ pixel_pokemon: [] });
    await expect(fetchSeededCandidates('Eevee')).resolves.toEqual([]);
  });
});
