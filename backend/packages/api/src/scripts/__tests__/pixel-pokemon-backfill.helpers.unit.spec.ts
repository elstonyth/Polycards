import { proposeRow } from '../pixel-pokemon-backfill.helpers';

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
