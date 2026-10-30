import { entryLabel, parsePixelPokemonBody } from '../parse';

// One library, separate decks: Pokémon numbered by dex, One Piece by number,
// and neither may carry the other's — a One Piece row with a dex would be
// mirrored onto its cards as that Pokémon.

const base = {
  name: 'Monkey D. Luffy',
  image_url: 'https://cdn.example/luffy.gif',
};

describe('parsePixelPokemonBody', () => {
  it('defaults to a Pokémon custom sprite (back-compat with existing callers)', () => {
    const r = parsePixelPokemonBody({ ...base, dex: 25 });
    expect(r).toEqual({
      ok: true,
      value: expect.objectContaining({
        franchise: 'pokemon',
        dex: 25,
        number: null,
        variant: 'custom',
        types: [],
      }),
    });
  });

  it('accepts a One Piece base sprite with its own number', () => {
    const r = parsePixelPokemonBody({
      ...base,
      franchise: 'one-piece',
      number: 1,
      variant: 'normal',
      types: ['One Piece'],
    });
    expect(r).toEqual({
      ok: true,
      value: expect.objectContaining({
        franchise: 'one-piece',
        dex: null,
        number: 1,
        variant: 'normal',
        types: ['One Piece'],
      }),
    });
  });

  it('refuses a dex on a One Piece sprite and a number on a Pokémon', () => {
    expect(
      parsePixelPokemonBody({ ...base, franchise: 'one-piece', dex: 25 }),
    ).toEqual({ ok: false, message: expect.stringContaining('no dex') });
    expect(parsePixelPokemonBody({ ...base, number: 1 })).toEqual({
      ok: false,
      message: expect.stringContaining("by 'dex'"),
    });
  });

  it('refuses an unknown franchise and out-of-range numbers', () => {
    expect(parsePixelPokemonBody({ ...base, franchise: 'yugioh' }).ok).toBe(
      false,
    );
    expect(
      parsePixelPokemonBody({ ...base, franchise: 'one-piece', number: 0 }).ok,
    ).toBe(false);
    expect(
      parsePixelPokemonBody({ ...base, franchise: 'one-piece', number: 1.5 })
        .ok,
    ).toBe(false);
    expect(parsePixelPokemonBody({ ...base, dex: 1026 }).ok).toBe(false);
  });

  it('keeps the existing name / image_url guards', () => {
    expect(parsePixelPokemonBody({ ...base, name: '  ' }).ok).toBe(false);
    for (const image_url of [
      'javascript:alert(1)',
      '//evil.example/x.gif',
      '',
    ]) {
      expect(parsePixelPokemonBody({ ...base, image_url }).ok).toBe(false);
    }
    expect(
      parsePixelPokemonBody({ ...base, image_url: '/static/x.gif' }).ok,
    ).toBe(true);
  });

  it('labels duplicates by each deck’s own number', () => {
    expect(entryLabel({ franchise: 'pokemon', dex: 25, number: null })).toBe(
      'dex 25',
    );
    expect(entryLabel({ franchise: 'one-piece', dex: null, number: 1 })).toBe(
      'one-piece #1',
    );
  });
});
