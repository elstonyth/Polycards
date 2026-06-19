import { describe, it, expect } from 'vitest';
import type { EditRow } from './odds-rows';
import { groupRowsByPokemon } from './group-rows';

const row = (over: Partial<EditRow> = {}): EditRow => ({
  card_id: 'c',
  name: 'Charizard',
  image: '',
  rarity: 'Rare',
  market_value: 100,
  stock: 10,
  currentPct: 10,
  locked: false,
  pctInput: '10',
  ...over,
});

describe('groupRowsByPokemon', () => {
  it('groups rows by derived dex, ordered dex-ascending', () => {
    const groups = groupRowsByPokemon([
      row({ card_id: '1', name: 'Charizard GX' }), // dex 6
      row({ card_id: '2', name: 'Pikachu V' }), // dex 25
      row({ card_id: '3', name: 'Charizard (Base)' }), // dex 6
    ]);
    expect(groups.map((g) => g.pokemon?.dex)).toEqual([6, 25]);
    expect(groups[0].key).toBe('6');
    expect(groups[0].rows.map((r) => r.card_id)).toEqual(['1', '3']);
  });

  it('collects unresolvable cards into one "Other" group, always last', () => {
    const groups = groupRowsByPokemon([
      row({ card_id: 'e', name: 'Double Colorless Energy' }),
      row({ card_id: 'p', name: 'Pikachu' }),
    ]);
    expect(groups.at(-1)?.pokemon).toBeNull();
    expect(groups.at(-1)?.key).toBe('other');
    expect(groups.at(-1)?.rows.map((r) => r.card_id)).toEqual(['e']);
  });

  it('preserves incoming order within a group and keeps every row once', () => {
    const groups = groupRowsByPokemon([
      row({ card_id: 'a', name: 'Mew' }),
      row({ card_id: 'b', name: 'Mewtwo' }),
      row({ card_id: 'c', name: 'Mew' }),
    ]);
    expect(groups.reduce((n, g) => n + g.rows.length, 0)).toBe(3);
    const mew = groups.find((g) => g.pokemon?.name === 'Mew');
    expect(mew?.rows.map((r) => r.card_id)).toEqual(['a', 'c']);
  });
});
