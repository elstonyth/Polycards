import { applyRow, proposeRow } from '../pixel-pokemon-backfill.helpers';

describe('proposeRow', () => {
  test('flags the Rockruff/Lycanroc card as ambiguous with both matches', () => {
    const row = proposeRow({
      id: 'card_1',
      name: '2016 Pokemon Japanese Sun & Moon Rockruff Full Power Deck Holo Lycanroc GX #9 CGC 5.5',
    });
    expect(row.ambiguous).toBe(true);
    expect(row.all_matches.map((m) => m.dex).sort((a, b) => a - b)).toEqual([
      744, 745,
    ]);
    // chosen_dex defaults to the first proposal so the human only edits flagged rows
    expect(row.chosen_dex).toBe(row.proposed_dex);
  });

  test('a clean single-species card is not ambiguous', () => {
    const row = proposeRow({
      id: 'card_2',
      name: '2023 Pokemon Japanese Scarlet & Violet 151 Holo Gengar #94 CGC 10 GEM MINT',
    });
    expect(row.ambiguous).toBe(false);
    expect(row.proposed_species).toBe('Gengar');
    expect(row.chosen_dex).toBe(94);
  });

  test('a card with no species resolves to nulls (stays unlinked)', () => {
    const row = proposeRow({
      id: 'card_3',
      name: '2022 Pokemon Trainer Gallery Full Art Energy',
    });
    expect(row.all_matches).toEqual([]);
    expect(row.proposed_dex).toBeNull();
    expect(row.chosen_dex).toBeNull();
  });
});

describe('applyRow (canonical regression — Rockruff card links to Lycanroc)', () => {
  const pixelByDex = new Map<
    number,
    { id: string; dex: number | null; image_url: string | null }
  >([
    [744, { id: 'pp_744', dex: 744, image_url: 'https://cdn/pixel-744.gif' }],
    [745, { id: 'pp_745', dex: 745, image_url: 'https://cdn/pixel-745.gif' }],
  ]);

  test('a corrected chosen_dex=745 links to Lycanroc and mirrors its sprite', () => {
    const row = {
      card_id: 'card_1',
      card_name: 'Rockruff … Lycanroc GX',
      proposed_dex: 744,
      proposed_species: 'Rockruff',
      all_matches: [
        { dex: 744, name: 'Rockruff' },
        { dex: 745, name: 'Lycanroc' },
      ],
      ambiguous: true,
      chosen_dex: 745,
    };
    expect(applyRow(row, pixelByDex)).toEqual({
      id: 'card_1',
      pixel_pokemon_id: 'pp_745',
      pokemon_dex: 745,
      sprite_image: 'https://cdn/pixel-745.gif',
    });
  });

  test('a chosen entry with null dex/image mirrors nulls (custom entry)', () => {
    const withNull = new Map(pixelByDex);
    withNull.set(9999, { id: 'pp_9999', dex: null, image_url: null });
    const row = {
      card_id: 'card_5',
      card_name: 'Custom art card',
      proposed_dex: 9999,
      proposed_species: 'Custom',
      all_matches: [{ dex: 9999, name: 'Custom' }],
      ambiguous: false,
      chosen_dex: 9999,
    };
    expect(applyRow(row, withNull)).toEqual({
      id: 'card_5',
      pixel_pokemon_id: 'pp_9999',
      pokemon_dex: null,
      sprite_image: null,
    });
  });

  test('a row with no chosen dex is skipped (stays unlinked)', () => {
    const row = {
      card_id: 'card_3',
      card_name: 'Trainer Energy',
      proposed_dex: null,
      proposed_species: null,
      all_matches: [],
      ambiguous: false,
      chosen_dex: null,
    };
    expect(applyRow(row, pixelByDex)).toBeNull();
  });

  test('a chosen dex with no seeded entry is skipped', () => {
    const row = {
      card_id: 'card_4',
      card_name: 'Missingno',
      proposed_dex: 999,
      proposed_species: 'X',
      all_matches: [{ dex: 999, name: 'X' }],
      ambiguous: false,
      chosen_dex: 999,
    };
    expect(applyRow(row, pixelByDex)).toBeNull();
  });
});
