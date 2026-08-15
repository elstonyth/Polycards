import {
  cardByHandle,
  compositionGroup,
  isGraded,
  isPsa10,
  makeRarityOf,
  poolComposition,
  toCardView,
} from '../card-view';

const card = {
  handle: 'pikachu-001',
  name: 'Pikachu',
  set: 'Base',
  grader: 'PSA',
  grade: '10',
  market_value: '0.15',
  image: '/p.png',
  slab_image: null,
};

describe('cardByHandle', () => {
  it('indexes cards by handle', () => {
    const m = cardByHandle([card]);
    expect(m.get('pikachu-001')).toBe(card);
    expect(m.size).toBe(1);
  });
});

describe('isGraded', () => {
  it('treats a non-blank grader as graded', () => {
    expect(isGraded({ grader: 'PSA' })).toBe(true);
    expect(isGraded({ grader: ' BGS ' })).toBe(true);
  });

  // A raw card carries an EMPTY grader (the column is NOT NULL), and a
  // whitespace-only one is the same thing typed sloppily — both must read RAW,
  // or a pack of raw cards reports GRADED.
  it('treats an empty or whitespace-only grader as raw', () => {
    expect(isGraded({ grader: '' })).toBe(false);
    expect(isGraded({ grader: '  ' })).toBe(false);
  });
});

describe('isPsa10', () => {
  it('requires grader PSA AND grade 10, tolerant of case/whitespace', () => {
    expect(isPsa10({ grader: 'PSA', grade: '10' })).toBe(true);
    expect(isPsa10({ grader: ' psa ', grade: ' 10 ' })).toBe(true);
  });

  // Graded alone must NOT pass the guarantee gate: a PSA 9 or a BGS 10 is
  // graded but the "Guaranteed PSA 10" heading would be false advertising.
  it('rejects other grades, other graders, and raw cards', () => {
    expect(isPsa10({ grader: 'PSA', grade: '9' })).toBe(false);
    expect(isPsa10({ grader: 'BGS', grade: '10' })).toBe(false);
    expect(isPsa10({ grader: '', grade: '' })).toBe(false);
  });
});

describe('compositionGroup', () => {
  it('classifies GRADED / RAW / MIX and nulls an empty pool', () => {
    expect(compositionGroup(3, 3)).toBe('GRADED');
    expect(compositionGroup(0, 3)).toBe('RAW');
    expect(compositionGroup(1, 3)).toBe('MIX');
    expect(compositionGroup(0, 0)).toBeNull();
  });
});

describe('poolComposition', () => {
  const cards = [
    { handle: 'psa10', grader: 'PSA', grade: '10' },
    { handle: 'psa9', grader: 'PSA', grade: '9' },
    { handle: 'raw', grader: '', grade: '' },
  ];
  it('counts graded/psa10/total per pack, skipping reward rows and orphans', () => {
    const comp = poolComposition(
      [
        { pack_id: 'a', card_id: 'psa10' },
        { pack_id: 'a', card_id: 'psa9' },
        { pack_id: 'a', card_id: 'raw' },
        { pack_id: 'a', card_id: null }, // reward row — no card
        { pack_id: 'a', card_id: 'deleted' }, // orphaned odds row
        { pack_id: 'b', card_id: 'psa10' },
      ],
      cards,
    );
    expect(comp.get('a')).toEqual({ graded: 2, psa10: 1, total: 3 });
    expect(comp.get('b')).toEqual({ graded: 1, psa10: 1, total: 1 });
    expect(comp.has('empty')).toBe(false);
  });
});

describe('makeRarityOf', () => {
  const odds = [{ pack_id: 'p1', card_id: 'pikachu-001', rarity: 'Mythical' }];
  it('looks rarity up by (pack, card) pair', () => {
    const rarityOf = makeRarityOf(odds);
    expect(rarityOf('p1', 'pikachu-001')).toBe('Mythical');
  });
  it('defaults missing pairs to Common', () => {
    const rarityOf = makeRarityOf(odds);
    expect(rarityOf('p9', 'nope')).toBe('Common');
  });
});

describe('toCardView', () => {
  it('shapes the canonical 8-field card view with money-normalized FMV', () => {
    expect(toCardView(card, 'Mythical')).toEqual({
      handle: 'pikachu-001',
      name: 'Pikachu',
      set: 'Base',
      grader: 'PSA',
      grade: '10',
      rarity: 'Mythical',
      market_value: 0.15,
      image: '/p.png',
      slab_image: null,
    });
  });

  it('passes slab_image through, defaulting to null', () => {
    const base = {
      handle: 'h',
      name: 'N',
      set: 'S',
      grader: 'PSA',
      grade: '9',
      market_value: 10,
      image: '/i.webp',
      slab_image: '/s.webp' as string | null,
    };
    expect(toCardView(base, 'Rare').slab_image).toBe('/s.webp');
    expect(
      toCardView({ ...base, slab_image: null }, 'Rare').slab_image,
    ).toBeNull();
  });
});
