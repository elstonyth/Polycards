import { byValue, groupPayouts, prizeValue } from '../results';

const snap = { pool_myr: 938302.54, unlocked_stages: [1, 2] };

describe('groupPayouts', () => {
  it('folds settlement rows into one entry per winner, in paid rank order', () => {
    const rows = [
      {
        customer_id: 'c4',
        rank: 4,
        kind: 'credits',
        card_id: '',
        credits: '2000',
        snapshot: snap,
      },
      {
        customer_id: 'c1',
        rank: 1,
        kind: 'card',
        card_id: 'gengar',
        credits: 0,
        snapshot: { ...snap, qty: 1 },
      },
      {
        customer_id: 'c1',
        rank: 1,
        kind: 'card',
        card_id: 'pika',
        credits: 0,
        snapshot: { ...snap, qty: 2 },
      },
      {
        customer_id: 'c1',
        rank: 1,
        kind: 'credits',
        card_id: '',
        credits: 150,
        snapshot: snap,
      },
      // A second row for one winner that disagrees on rank keeps the first.
      {
        customer_id: 'c4',
        rank: 5,
        kind: 'credits',
        card_id: '',
        credits: 50,
        snapshot: snap,
      },
    ];
    expect(groupPayouts(rows)).toEqual([
      {
        customerId: 'c1',
        rank: 1,
        credits: 150,
        cards: [
          { cardId: 'gengar', qty: 1 },
          { cardId: 'pika', qty: 2 },
        ],
        poolMyr: 938302.54,
        unlockedStages: [1, 2],
      },
      {
        customerId: 'c4',
        rank: 4,
        credits: 2050,
        cards: [],
        poolMyr: 938302.54,
        unlockedStages: [1, 2],
      },
    ]);
  });

  it('reads a row with no snapshot as one card and no pool', () => {
    expect(
      groupPayouts([
        {
          customer_id: 'c1',
          rank: 1,
          kind: 'card',
          card_id: 'x',
          credits: 0,
          snapshot: null,
        },
      ]),
    ).toEqual([
      {
        customerId: 'c1',
        rank: 1,
        credits: 0,
        cards: [{ cardId: 'x', qty: 1 }],
        poolMyr: null,
        unlockedStages: [],
      },
    ]);
  });
});

describe('prizeValue and byValue', () => {
  const cards = [
    { name: 'Cheap', title: 'Cheap', image: null, qty: 2, valueMyr: 10.5 },
    { name: 'Gone', title: 'Gone', image: null, qty: 1, valueMyr: null },
    { name: 'Chase', title: 'Chase', image: null, qty: 1, valueMyr: 3332.95 },
  ];

  it('adds the credits and every card at its value, a gone card as nothing', () => {
    expect(prizeValue(100, cards)).toBe(3453.95);
    expect(prizeValue(80, [])).toBe(80);
  });

  it('puts the most valuable card first and a gone card last', () => {
    expect(byValue(cards).map((c) => c.name)).toEqual([
      'Chase',
      'Cheap',
      'Gone',
    ]);
  });
});
