import { describe, it, expect } from 'vitest';
import type { OddsRow } from './packs-api';
import { mapOddsToRows, rowsToOddsInputs, type EditRow } from './odds-rows';

const oddsRow = (over: Partial<OddsRow> = {}): OddsRow => ({
  card_id: 'card_1',
  name: 'Charizard',
  image: 'charizard.png',
  rarity: 'Rare',
  market_value: 100,
  stock: 10,
  weight: 150,
  locked: false,
  pct: 12.5,
  ...over,
});

const editRow = (over: Partial<EditRow> = {}): EditRow => ({
  card_id: 'card_1',
  name: 'Charizard',
  image: 'charizard.png',
  rarity: 'Rare',
  market_value: 100,
  stock: 10,
  currentPct: 12.5,
  locked: false,
  pctInput: '12.5',
  ...over,
});

describe('mapOddsToRows', () => {
  it('copies card facts and seeds currentPct + pctInput from pct', () => {
    expect(mapOddsToRows([oddsRow()])).toEqual([
      {
        card_id: 'card_1',
        name: 'Charizard',
        image: 'charizard.png',
        rarity: 'Rare',
        market_value: 100,
        stock: 10,
        currentPct: 12.5,
        locked: false,
        pctInput: '12.5',
      },
    ]);
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
      editRow({ card_id: 'b', pctInput: '20', locked: false, rarity: 'Common' }),
    ];
    expect(rowsToOddsInputs(rows)).toEqual([
      { card_id: 'a', locked: true, pct: 10, rarity: 'Rare' },
      { card_id: 'b', locked: false, pct: 20, rarity: 'Common' },
    ]);
  });
});
