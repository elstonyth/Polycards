import { describe, it, expect } from 'vitest';
import type { OddsRow } from './packs-api';
import {
  mapOddsToRows,
  previewSets,
  publishedEvPreview,
  rowsToSetEntries,
  setEvRtp,
  type EditRow,
} from './odds-rows';

const oddsRow = (over: Partial<OddsRow> = {}): OddsRow => ({
  card_id: 'card_1',
  name: 'Charizard',
  image: 'charizard.png',
  slab_image: null,
  rarity: 'Rare',
  market_value: 100,
  stock: 10,
  weight: 150,
  weight_2: null,
  weight_3: null,
  locked: false,
  pct: 12.5,
  pct_2: 12.5,
  pct_3: 12.5,
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
  pctInput2: '',
  pctInput3: '',
  topHitInput: '',
  ...over,
});

// A Rare + a Legendary pinned against a single unlocked Common balancer —
// the smallest pool that exercises "the balancer absorbs the remainder".
const trio = (over: { pctInput2?: string; pctInput3?: string } = {}) => [
  editRow({ card_id: 'a', rarity: 'Rare', pctInput: '10', ...over }),
  editRow({ card_id: 'b', rarity: 'Legendary', pctInput: '5' }),
  editRow({ card_id: 'c', rarity: 'Common', pctInput: '85' }),
];

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
        pctInput2: '',
        pctInput3: '',
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

  it('seeds set-2/3 inputs from the RAW weights: null → inherit, bps → %', () => {
    const [a, b] = mapOddsToRows([
      oddsRow({ weight_2: 1250, weight_3: null }),
      oddsRow({ card_id: 'card_2', weight_2: null, weight_3: 0 }),
    ]);
    expect(a.pctInput2).toBe('12.5');
    expect(a.pctInput3).toBe('');
    expect(b.pctInput2).toBe('');
    // An explicit 0% is a real override, NOT inheritance — it must not collapse
    // into the empty string (which would silently re-inherit on the next save).
    expect(b.pctInput3).toBe('0');
  });

  it('does not carry the server weight field into the editable row', () => {
    const [row] = mapOddsToRows([oddsRow({ weight: 999 })]);
    expect(row).not.toHaveProperty('weight');
  });
});

describe('rowsToSetEntries', () => {
  it('maps each row to the odds-math entry shape, parsing pctInput to a number', () => {
    expect(
      rowsToSetEntries([editRow({ pctInput: '20', locked: true })]),
    ).toEqual([
      {
        card_id: 'card_1',
        locked: true,
        pct: 20,
        rarity: 'Rare',
        pct_2: null,
        pct_3: null,
      },
    ]);
  });

  it('maps an EMPTY set-2/3 input to null (inherit), never to 0', () => {
    const [e] = rowsToSetEntries([editRow({ pctInput2: '', pctInput3: '' })]);
    expect(e.pct_2).toBeNull();
    expect(e.pct_3).toBeNull();
  });

  it('maps an explicit "0" to the NUMBER 0 (a real 0% override)', () => {
    const [e] = rowsToSetEntries([
      editRow({ pctInput2: '0', pctInput3: '7.5' }),
    ]);
    expect(e.pct_2).toBe(0);
    expect(e.pct_3).toBe(7.5);
  });

  it('sends numbers, not the raw input strings (the route 400s on a string)', () => {
    const [e] = rowsToSetEntries([editRow({ pctInput2: '40' })]);
    expect(typeof e.pct_2).toBe('number');
  });

  it('handles multiple rows in order', () => {
    expect(rowsToSetEntries(trio()).map((e) => [e.card_id, e.pct])).toEqual([
      ['a', 10],
      ['b', 5],
      ['c', 85],
    ]);
  });
});

describe('previewSets', () => {
  it('resolves set 1 with the unlocked Common absorbing the remainder', () => {
    const { error, pct } = previewSets(trio());
    expect(error).toBeNull();
    expect(pct[1].get('a')).toBe(10);
    expect(pct[1].get('b')).toBe(5);
    expect(pct[1].get('c')).toBe(85);
  });

  it('a set-2 override moves ONLY the balancer in set 2 — set 1 is untouched', () => {
    const { pct } = previewSets(trio({ pctInput2: '20' }));
    // Set 1 keeps its own table.
    expect(pct[1].get('a')).toBe(10);
    expect(pct[1].get('c')).toBe(85);
    // Set 2: 'a' takes its override, 'b' inherits, Common eats the difference.
    expect(pct[2].get('a')).toBe(20);
    expect(pct[2].get('b')).toBe(5);
    expect(pct[2].get('c')).toBe(75);
  });

  it('set 3 mirrors set 2 when nothing overrides it (3 → 2 → 1)', () => {
    const { pct } = previewSets(trio({ pctInput2: '20' }));
    expect(pct[3].get('a')).toBe(20);
    expect(pct[3].get('b')).toBe(5);
    expect(pct[3].get('c')).toBe(75);
  });

  it('every set sums to 100% when valid', () => {
    const { pct } = previewSets(trio({ pctInput2: '20', pctInput3: '30' }));
    for (const set of [1, 2, 3] as const) {
      const sum = [...pct[set].values()].reduce((s, p) => s + p, 0);
      expect(sum).toBe(100);
    }
  });

  it('propagates a set-2 failure with the "Set 2:" prefix and no pcts', () => {
    const { error, pct } = previewSets(trio({ pctInput2: '120' }));
    expect(error).toMatch(/^Set 2: /);
    expect(pct[2].size).toBe(0);
  });

  it('propagates a set-1 failure verbatim (no prefix)', () => {
    const rows = [
      editRow({ card_id: 'a', rarity: 'Rare', pctInput: '60' }),
      editRow({ card_id: 'b', rarity: 'Legendary', pctInput: '60' }),
    ];
    expect(previewSets(rows).error).toBe(
      'Common win rate would go below 0%. Lower the other rates.',
    );
  });
});

describe('setEvRtp', () => {
  it('folds price × pct in integer cents, like the backend RTP report', () => {
    const rows = [
      editRow({ card_id: 'a', market_value: 10 }),
      editRow({ card_id: 'b', market_value: 100 }),
    ];
    const pct = new Map([
      ['a', 90],
      ['b', 10],
    ]);
    // 1000c × 0.9 + 10000c × 0.1 = 1900c
    expect(setEvRtp(rows, pct, 10)).toEqual({ ev: 19, rtp: 190 });
  });

  it('derives RTP from the UNROUNDED EV (16.67%, not 16.7%)', () => {
    const rows = [editRow({ card_id: 'a', market_value: 10 })];
    const pct = new Map([['a', 16.667]]);
    // 166.67c → EV rounds to 1.67, but RTP must come off the raw 1.6667.
    expect(setEvRtp(rows, pct, 10)).toEqual({ ev: 1.67, rtp: 16.67 });
  });

  it('returns null for an empty pool, an unpriced pack, or an errored preview', () => {
    const rows = [editRow({ card_id: 'a', market_value: 10 })];
    const pct = new Map([['a', 100]]);
    expect(setEvRtp([], pct, 10)).toBeNull();
    expect(setEvRtp(rows, pct, 0)).toBeNull();
    expect(setEvRtp(rows, new Map(), 10)).toBeNull();
  });
});

describe('publishedEvPreview', () => {
  const rows = [
    editRow({ card_id: 'a', rarity: 'Rare', market_value: 90 }),
    editRow({ card_id: 'b', rarity: 'Rare', market_value: 110 }),
    editRow({ card_id: 'c', rarity: 'Common', market_value: 10 }),
  ];

  it('folds (tier average price × published %) over the filled-in tiers', () => {
    // Rare averages 100 → 10000c × 0.05 = 500c; Common 1000c × 0.95 = 950c.
    expect(publishedEvPreview(rows, { Rare: '5', Common: '95' })).toBe(14.5);
  });

  it('skips blank tiers and tiers with no card in the pool', () => {
    expect(
      publishedEvPreview(rows, { Rare: '5', Common: '', Legendary: '1' }),
    ).toBe(5);
  });

  it('returns null when nothing contributes', () => {
    expect(publishedEvPreview(rows, { Legendary: '1' })).toBeNull();
    expect(publishedEvPreview([], { Rare: '5' })).toBeNull();
    expect(publishedEvPreview(rows, {})).toBeNull();
  });
});

import {
  applyRarityProposals,
  applySolveResult,
  hasMaterializedSetOverrides,
  rowsToSolveInput,
} from './odds-rows';

const row = (over: Partial<EditRow> = {}): EditRow => ({
  card_id: 'c1',
  name: 'Card',
  image: '',
  slab_image: null,
  rarity: 'Common',
  market_value: 100,
  stock: null,
  currentPct: 0,
  locked: false,
  pctInput: '0',
  pctInput2: '',
  pctInput3: '',
  topHitInput: '',
  ...over,
});

describe('auto-split mapping helpers', () => {
  it('maps editor rows to solver rows using the display price', () => {
    const rows = [
      row({
        card_id: 'a',
        market_value: 24.55,
        locked: true,
        pctInput: '12.5',
      }),
    ];
    expect(rowsToSolveInput(rows)).toEqual([
      { card_id: 'a', locked: true, rarity: 'Common', value: 24.55, pct: 12.5 },
    ]);
  });

  it('treats an UNLOCKED blank or malformed pct as 0 rather than NaN', () => {
    expect(
      rowsToSolveInput([row({ locked: false, pctInput: '' })])[0].pct,
    ).toBe(0);
    expect(
      rowsToSolveInput([row({ locked: false, pctInput: '12.' })])[0].pct,
    ).toBe(12);
    expect(
      rowsToSolveInput([row({ locked: false, pctInput: 'abc' })])[0].pct,
    ).toBe(0);
  });

  it("preserves NaN for a LOCKED blank or malformed pct, so solveOddsForRtp's own range guard rejects it instead of silently pinning at 0%", () => {
    expect(
      rowsToSolveInput([row({ locked: true, pctInput: '' })])[0].pct,
    ).toBeNaN();
    expect(
      rowsToSolveInput([row({ locked: true, pctInput: '   ' })])[0].pct,
    ).toBeNaN();
    expect(
      rowsToSolveInput([row({ locked: true, pctInput: 'abc' })])[0].pct,
    ).toBeNaN();
    // A LOCKED valid rate still passes through as a number, unaffected.
    expect(
      rowsToSolveInput([row({ locked: true, pctInput: '12.5' })])[0].pct,
    ).toBe(12.5);
  });

  it('applies rarity proposals without touching other fields', () => {
    const rows = [row({ card_id: 'a' }), row({ card_id: 'b' })];
    const out = applyRarityProposals(rows, [
      { card_id: 'b', rarity: 'Legendary' },
    ]);
    expect(out[0].rarity).toBe('Common');
    expect(out[1].rarity).toBe('Legendary');
    expect(out).not.toBe(rows);
    expect(rows[1].rarity).toBe('Common');
  });

  it('writes solved rates into the input for the targeted set only', () => {
    const rows = [
      row({ card_id: 'a', pctInput: '1', pctInput2: '', pctInput3: '' }),
    ];
    const result = {
      error: null,
      computed: [{ card_id: 'a', pct: 42.5 }],
      floored: [],
      tierCollapse: [],
      achievedRtp: 0.7,
    };
    const set2 = applySolveResult(rows, result, 2);
    expect(set2[0].pctInput).toBe('1');
    expect(set2[0].pctInput2).toBe('42.5');
    expect(set2[0].pctInput3).toBe('');
    // The helper must not mutate the row it was given — only the returned
    // copy changes. A regression to in-place mutation of the row object
    // would leave this passing on set2 while corrupting the original.
    expect(rows[0].pctInput2).toBe('');
  });

  it('writes the set-1 success path into pctInput only, and 0% round-trips to "0"', () => {
    const rows = [
      row({ card_id: 'a', pctInput: '1', pctInput2: '5', pctInput3: '' }),
      row({ card_id: 'b', pctInput: '99', pctInput2: '', pctInput3: '' }),
    ];
    const result = {
      error: null,
      computed: [
        { card_id: 'a', pct: 33.3 },
        { card_id: 'b', pct: 0 },
      ],
      floored: [],
      tierCollapse: [],
      achievedRtp: 0.5,
    };
    const set1 = applySolveResult(rows, result, 1);
    expect(set1[0].pctInput).toBe('33.3');
    expect(set1[0].pctInput2).toBe('5');
    expect(set1[0].pctInput3).toBe('');
    // An explicit 0% must round-trip to the string '0', never '' — '' means
    // "inherit the previous set" in this editor, a different thing entirely.
    expect(set1[1].pctInput).toBe('0');
  });

  it('applies nothing when the solve errored', () => {
    const rows = [row({ card_id: 'a', pctInput: '1' })];
    const result = {
      error: 'nope',
      computed: [],
      floored: [],
      tierCollapse: [],
      achievedRtp: null,
    };
    expect(applySolveResult(rows, result, 1)).toEqual(rows);
  });
});

describe('hasMaterializedSetOverrides', () => {
  it('is false when every row purely inherits sets 2/3 (both inputs blank)', () => {
    const rows = [
      row({ card_id: 'a', pctInput2: '', pctInput3: '' }),
      row({ card_id: 'b', pctInput2: '', pctInput3: '' }),
    ];
    expect(hasMaterializedSetOverrides(rows)).toBe(false);
  });

  it('is false for an empty row set', () => {
    expect(hasMaterializedSetOverrides([])).toBe(false);
  });

  it('is true when any row carries a non-empty set-2 input', () => {
    const rows = [
      row({ card_id: 'a' }),
      row({ card_id: 'b', pctInput2: '12.5' }),
    ];
    expect(hasMaterializedSetOverrides(rows)).toBe(true);
  });

  it('is true when any row carries a non-empty set-3 input, including an explicit "0"', () => {
    expect(hasMaterializedSetOverrides([row({ pctInput3: '0' })])).toBe(true);
  });
});
