import { describe, it, expect } from 'vitest';
import type { OddsRow } from './packs-api';
import { mapOddsToRows, rowsToOddsInputs, type EditRow } from './odds-rows';

const oddsRow = (over: Partial<OddsRow> = {}): OddsRow => ({
  card_id: 'card_1',
  name: 'Charizard',
  image: 'charizard.png',
  slab_image: null,
  rarity: 'Rare',
  market_value: 100,
  stock: 10,
  weight: 150,
  locked: false,
  pct: 12.5,
  top_hit_order: null,
  ...over,
});

const editRow = (over: Partial<EditRow> = {}): EditRow => ({
  card_id: 'card_1',
  name: 'Charizard',
  image: 'charizard.png',
  slab_image: null,
  rarity: 'Rare',
  market_value: 100,
  stock: 10,
  currentPct: 12.5,
  locked: false,
  pctInput: '12.5',
  topHitInput: '',
  ...over,
});

describe('mapOddsToRows', () => {
  it('copies card facts and seeds currentPct + pctInput from pct', () => {
    expect(mapOddsToRows([oddsRow()])).toEqual([
      {
        card_id: 'card_1',
        name: 'Charizard',
        image: 'charizard.png',
        slab_image: null,
        rarity: 'Rare',
        market_value: 100,
        stock: 10,
        currentPct: 12.5,
        locked: false,
        pctInput: '12.5',
        topHitInput: '',
      },
    ]);
  });

  it('seeds topHitInput from top_hit_order (number → string, null → empty)', () => {
    const [a, b] = mapOddsToRows([
      oddsRow({ top_hit_order: 2 }),
      oddsRow({ card_id: 'card_2', top_hit_order: null }),
    ]);
    expect(a.topHitInput).toBe('2');
    expect(b.topHitInput).toBe('');
  });

  it('does not carry the server weight field into the editable row', () => {
    const [row] = mapOddsToRows([oddsRow({ weight: 999 })]);
    expect(row).not.toHaveProperty('weight');
  });
});

describe('rowsToOddsInputs', () => {
  it('maps each row to the odds-math input shape, parsing pctInput to a number', () => {
    expect(
      rowsToOddsInputs([editRow({ pctInput: '20', locked: true })]),
    ).toEqual([{ card_id: 'card_1', locked: true, pct: 20, rarity: 'Rare' }]);
  });

  it('handles multiple rows in order', () => {
    const rows = [
      editRow({ card_id: 'a', pctInput: '10', locked: true }),
      editRow({
        card_id: 'b',
        pctInput: '20',
        locked: false,
        rarity: 'Common',
      }),
    ];
    expect(rowsToOddsInputs(rows)).toEqual([
      { card_id: 'a', locked: true, pct: 10, rarity: 'Rare' },
      { card_id: 'b', locked: false, pct: 20, rarity: 'Common' },
    ]);
  });
});
