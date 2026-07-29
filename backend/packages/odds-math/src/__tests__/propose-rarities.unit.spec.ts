import { proposeRarities } from '../index';

// bronze-pack display prices (FMV USD x 4.091 fx x 1.2 markup), RM 50 ticket.
const BRONZE = [
  { card_id: 'pw-pikachu', value: 24.55 },
  { card_id: 'pw-bulbasaur', value: 39.27 },
  { card_id: 'pw-jolteon', value: 122.73 },
  { card_id: 'pw-gengar', value: 589.1 },
  { card_id: 'pw-charizard', value: 1718.22 },
  { card_id: 'mega-dragonite', value: 1829.51 },
  { card_id: 'pw-mewtwo', value: 4418.28 },
  { card_id: 'pikachu-grey-felt', value: 4856.08 },
  { card_id: 'pikachu-ex-238', value: 4860.11 },
  { card_id: 'mega-charizard-x', value: 9867.49 },
];

const tierOf = (rows: { card_id: string; value: number }[], price: number) =>
  Object.fromEntries(proposeRarities(rows, price).map((p) => [p.card_id, p.rarity]));

describe('proposeRarities', () => {
  it('tiers the bronze-pack pool against its RM 50 ticket', () => {
    expect(tierOf(BRONZE, 50)).toEqual({
      'pw-pikachu': 'Common',
      'pw-bulbasaur': 'Common',
      'pw-jolteon': 'Uncommon',
      'pw-gengar': 'Rare',
      'pw-charizard': 'Rare',
      'mega-dragonite': 'Rare',
      'pw-mewtwo': 'Mythical',
      'pikachu-grey-felt': 'Mythical',
      'pikachu-ex-238': 'Mythical',
      'mega-charizard-x': 'Legendary',
    });
  });

  it('treats each band edge as the START of the higher tier', () => {
    const edges = [
      { card_id: 'c', value: 100 }, // exactly 2x  -> Uncommon
      { card_id: 'u', value: 500 }, // exactly 10x -> Rare
      { card_id: 'r', value: 2500 }, // exactly 50x -> Mythical
      { card_id: 'm', value: 7500 }, // exactly 150x -> Legendary
      { card_id: 'l', value: 20000 }, // exactly 400x -> Immortal
    ];
    expect(tierOf(edges, 50)).toEqual({
      c: 'Uncommon',
      u: 'Rare',
      r: 'Mythical',
      m: 'Legendary',
      l: 'Immortal',
    });
  });

  it('degrades to Common on an unusable price or value', () => {
    const rows = [{ card_id: 'a', value: 9999 }];
    expect(tierOf(rows, 0)).toEqual({ a: 'Common' });
    expect(tierOf(rows, Number.NaN)).toEqual({ a: 'Common' });
    expect(tierOf([{ card_id: 'a', value: Number.NaN }], 50)).toEqual({ a: 'Common' });
    expect(tierOf([{ card_id: 'a', value: -10 }], 50)).toEqual({ a: 'Common' });
  });

  it('returns an empty list when rows is not an array', () => {
    // The editor can call this with a half-built form; a non-array must yield
    // an empty proposal rather than throwing.
    expect(proposeRarities(null as never, 50)).toEqual([]);
    expect(proposeRarities(undefined as never, 50)).toEqual([]);
  });
});
